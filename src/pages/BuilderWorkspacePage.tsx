import { useEffect, useState, type FormEvent } from 'react';
import {
  CheckSquare,
  Copy,
  Edit3,
  Lock,
  LogOut,
  Plus,
  RefreshCw,
  ShieldOff,
  Trash2,
  UserMinus,
  Users
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useLanguage } from '../contexts/LanguageContext';
import {
  approveOwnPendingRegistration,
  createTeamWithLeader,
  deleteFormingTeam,
  deleteProject,
  deleteRegistration,
  getTeamJoinCodeStatus,
  joinTeamByCode,
  leaveTeam,
  listPublishedHackathons,
  listTeamMembers,
  listUserProjects,
  listUserRegistrations,
  listUserTeams,
  removeTeamMember,
  resolveApprovedRegistrationForHackathon,
  revokeTeamJoinCode,
  rotateTeamJoinCode,
  saveProject,
  updateTeamDetails,
  withdrawParticipantRegistration
} from '../services/firebase/firestoreService';
import type {
  Hackathon,
  HackathonRegistration,
  Project,
  ProjectTask,
  Team,
  TeamMemberRecord
} from '../types/domain';
import { generateFirestoreId, isDeadlinePassed } from '../utils/validation';
import {
  loadOfflineDraftWork,
  saveOfflineDraftWork
} from '../services/hybridAI/inferenceManager';
import { RegistrationDiagnosticPanel } from '../components/diagnostics/RegistrationDiagnosticPanel';
import {
  formatActionableError,
  indexRegistrationsByHackathon,
  selectPreferredRegistration
} from '../utils/registrationResolution';

export function BuilderWorkspacePage() {
  const { user, profile, emailVerified } = useAuth();
  const { locale, t } = useLanguage();

  const [hackathons, setHackathons] = useState<Hackathon[]>([]);
  const [registrations, setRegistrations] = useState<HackathonRegistration[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamMembersMap, setTeamMembersMap] = useState<Record<string, TeamMemberRecord[]>>({});
  const [leaderJoinCodes, setLeaderJoinCodes] = useState<Record<string, string>>({});
  const [leaderCodeActive, setLeaderCodeActive] = useState<Record<string, boolean>>({});
  const [projects, setProjects] = useState<Project[]>([]);

  // Team create/edit forms
  const [teamHackathonId, setTeamHackathonId] = useState('');
  const [teamName, setTeamName] = useState('');
  const [teamTrack, setTeamTrack] = useState('');
  const [lookingRoles, setLookingRoles] = useState('AI Engineer, Frontend Developer');
  const [editingTeamId, setEditingTeamId] = useState<string | null>(null);
  const [editTeamName, setEditTeamName] = useState('');
  const [editTeamTrack, setEditTeamTrack] = useState('');
  const [editTeamRoles, setEditTeamRoles] = useState('');
  const [joinCodeInput, setJoinCodeInput] = useState('');

  // Project forms
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [projectTitle, setProjectTitle] = useState('');
  const [problemStatement, setProblemStatement] = useState('');
  const [proposedSolution, setProposedSolution] = useState('');
  const [targetUsers, setTargetUsers] = useState('');
  const [techText, setTechText] = useState('React, TypeScript, Firebase');
  const [projectNotes, setProjectNotes] = useState('');
  const [projectStatus, setProjectStatus] = useState<'ideation' | 'building'>('building');
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [activeProject, setActiveProject] = useState<Project | null>(null);

  const [busy, setBusy] = useState(false);
  const [confirmWithdrawRegId, setConfirmWithdrawRegId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [errorMsg, setErrorMsg] = useState('');

  const loadWorkspace = async () => {
    if (!user) return;
    const [hacksRes, regsRes, tmsRes, projsRes] = await Promise.allSettled([
      listPublishedHackathons(),
      listUserRegistrations(user.uid),
      listUserTeams(user.uid),
      listUserProjects(user.uid)
    ]);

    const loadErrors: string[] = [];
    const hacks =
      hacksRes.status === 'fulfilled'
        ? hacksRes.value
        : (loadErrors.push(formatActionableError(hacksRes.reason, 'Failed to load hackathons')), []);
    const regs =
      regsRes.status === 'fulfilled'
        ? regsRes.value
        : (loadErrors.push(formatActionableError(regsRes.reason, 'Failed to load registrations')), []);
    const tms =
      tmsRes.status === 'fulfilled'
        ? tmsRes.value
        : (loadErrors.push(formatActionableError(tmsRes.reason, 'Failed to load teams')), []);
    const projs =
      projsRes.status === 'fulfilled'
        ? projsRes.value
        : (loadErrors.push(formatActionableError(projsRes.reason, 'Failed to load projects')), []);

    if (loadErrors.length > 0) {
      setErrorMsg(loadErrors.join(' · '));
    }

    setHackathons(hacks);
    setRegistrations(regs);
    setTeams(tms);
    setProjects(projs);

    if (tms.length > 0) {
      const rosterEntries = await Promise.all(
        tms.map(async (tm) => {
          const members = await listTeamMembers(tm.id).catch(() => []);
          return [tm.id, members] as const;
        })
      );
      setTeamMembersMap(Object.fromEntries(rosterEntries));
    } else {
      setTeamMembersMap({});
    }

    const leaderTeams = tms.filter((tm) => tm.leaderId === user.uid);
    if (leaderTeams.length > 0) {
      const statusEntries = await Promise.all(
        leaderTeams.map(async (tm) => {
          const status = await getTeamJoinCodeStatus(tm.id);
          return [tm.id, Boolean(status?.active)] as const;
        })
      );
      setLeaderCodeActive(Object.fromEntries(statusEntries));
    } else {
      setLeaderCodeActive({});
    }

    const indexed = indexRegistrationsByHackathon(regs, user.uid);
    const approvedReg = Array.from(indexed.values()).find((r) => r.status === 'approved');
    setTeamHackathonId((prev) => {
      if (prev && hacks.some((h) => h.id === prev)) {
        return prev;
      }
      if (approvedReg) return approvedReg.hackathonId;
      if (regs.length > 0) return regs[0].hackathonId;
      if (hacks.length > 0) return hacks[0].id;
      return '';
    });

    if (tms.length > 0 && !selectedTeamId) {
      setSelectedTeamId(tms[0].id);
    }
    setActiveProject((prev) => {
      if (projs.length === 0) return null;
      const synced = prev ? projs.find((p) => p.id === prev.id) : undefined;
      return synced || projs[0];
    });
  };

  useEffect(() => {
    void loadWorkspace();
    const cached = loadOfflineDraftWork<{
      projectTitle?: string;
      problemStatement?: string;
      proposedSolution?: string;
      techText?: string;
    }>('builder_project');
    if (cached?.payload && !editingProjectId) {
      if (cached.payload.projectTitle) setProjectTitle(cached.payload.projectTitle);
      if (cached.payload.problemStatement) setProblemStatement(cached.payload.problemStatement);
      if (cached.payload.proposedSolution) setProposedSolution(cached.payload.proposedSolution);
      if (cached.payload.techText) setTechText(cached.payload.techText);
    }
  }, [user, emailVerified]);

  useEffect(() => {
    if (!editingProjectId && (projectTitle || problemStatement || proposedSolution)) {
      saveOfflineDraftWork('builder_project', {
        projectTitle,
        problemStatement,
        proposedSolution,
        techText
      });
    }
  }, [editingProjectId, projectTitle, problemStatement, proposedSolution, techText]);

  const resetProjectForm = () => {
    setEditingProjectId(null);
    setProjectTitle('');
    setProblemStatement('');
    setProposedSolution('');
    setTargetUsers('');
    setProjectNotes('');
    setTechText('React, TypeScript, Firebase');
    setProjectStatus('building');
  };

  const loadProjectIntoForm = (p: Project) => {
    setEditingProjectId(p.id);
    setSelectedTeamId(p.teamId);
    setProjectTitle(p.title);
    setProblemStatement(p.problemStatement || '');
    setProposedSolution(p.proposedSolution || '');
    setTargetUsers(p.targetUsers || '');
    setProjectNotes(p.notes || '');
    setTechText((p.technologies || []).join(', '));
    setProjectStatus(p.status === 'ideation' ? 'ideation' : 'building');
    setErrorMsg('');
    setFeedback('');
  };

  const handleWithdrawReg = async (reg: HackathonRegistration) => {
    if (!user || !emailVerified) return;
    if (confirmWithdrawRegId !== reg.id) {
      setConfirmWithdrawRegId(reg.id);
      return;
    }
    setBusy(true);
    setErrorMsg('');
    try {
      await withdrawParticipantRegistration({
        registration: reg,
        actorId: user.uid,
        actorName: profile?.displayName || user.displayName || 'Participant',
        confirmed: true
      });
      setConfirmWithdrawRegId(null);
      await loadWorkspace();
      setFeedback(locale === 'ar' ? 'تم سحب التسجيل.' : 'Registration withdrawn.');
    } catch (err) {
      setConfirmWithdrawRegId(null);
      setErrorMsg(formatActionableError(err, 'Failed to withdraw registration'));
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteReg = async (reg: HackathonRegistration) => {
    if (!user || !emailVerified) return;
    setBusy(true);
    setErrorMsg('');
    try {
      await deleteRegistration(reg.id);
      await loadWorkspace();
      setFeedback(locale === 'ar' ? 'تم حذف التسجيل.' : 'Registration deleted.');
    } catch (err) {
      setErrorMsg(formatActionableError(err, 'Failed to delete registration'));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPendingReg = async (reg: HackathonRegistration) => {
    if (!user || !emailVerified) return;
    setBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      await approveOwnPendingRegistration(reg.id);
      await loadWorkspace();
      setFeedback(
        locale === 'ar'
          ? 'تم تأكيد تسجيلك وتفعيله! يمكنك الآن إنشاء فريق أو الانضمام إلى فريق.'
          : 'Registration confirmed and approved! Team creation is now enabled.'
      );
    } catch (err) {
      setErrorMsg(formatActionableError(err, 'Failed to confirm registration'));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateTeam = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'يلزم حساب موثق البريد لإنشاء فريق.'
          : 'Verified account required to create a team.'
      );
      return;
    }
    const hack = hackathons.find((h) => h.id === teamHackathonId);
    if (!hack) {
      setErrorMsg(locale === 'ar' ? 'اختر هاكاثوناً منشوراً أولاً.' : 'Select a published hackathon first.');
      return;
    }
    setBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      let verification = await resolveApprovedRegistrationForHackathon(user.uid, hack.id);
      if (!verification.approved && verification.status === 'pending' && verification.registration) {
        await approveOwnPendingRegistration(verification.registration.id);
        verification = await resolveApprovedRegistrationForHackathon(user.uid, hack.id);
      }
      if (!verification.approved) {
        setErrorMsg(
          locale === 'ar'
            ? verification.status === 'pending'
              ? 'يلزم تأكيد تسجيلك المعلق قبل إنشاء فريق لهذا الهاكاثون.'
              : verification.status === 'rejected'
                ? 'تم رفض تسجيلك في هذا الهاكاثون من قِبل المنظم.'
                : verification.status === 'withdrawn'
                  ? 'تم سحب تسجيلك. أعد التقديم في صفحة استكشاف الهاكاثونات قبل انتهاء الموعد.'
                  : 'يجب التسجيل في هذا الهاكاثون أولاً من صفحة استكشاف الهاكاثونات.'
            : verification.reason
        );
        setBusy(false);
        return;
      }
      const { id, joinCode } = await createTeamWithLeader({
        hackathonId: hack.id,
        organizerId: hack.organizerId,
        name: teamName,
        description: '',
        leaderId: user.uid,
        memberIds: [user.uid],
        memberNames: [profile?.displayName || user.displayName || 'Builder'],
        lookingForRoles: lookingRoles.split(',').map((s) => s.trim()).filter(Boolean),
        track: teamTrack || hack.tracks?.[0] || 'General',
        status: 'forming'
      });
      setTeamName('');
      setSelectedTeamId(id);
      setLeaderJoinCodes((prev) => ({ ...prev, [id]: joinCode }));
      await loadWorkspace();
      setFeedback(
        locale === 'ar'
          ? `تم إنشاء الفريق! رمز الدعوة القابل لإعادة الاستخدام (احفظه الآن — لا يُخزن كنص صريح): ${joinCode}`
          : `Team created! Reusable invite code (copy now — never stored in plaintext): ${joinCode}`
      );
    } catch (err) {
      setErrorMsg(formatActionableError(err, 'Failed to create team'));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveTeamEdit = async (tm: Team) => {
    if (!user || !emailVerified || tm.leaderId !== user.uid) return;
    if (editTeamName.trim().length < 2) {
      setErrorMsg(locale === 'ar' ? 'اسم الفريق مطلوب.' : 'Team name must be at least 2 characters.');
      return;
    }
    setBusy(true);
    setErrorMsg('');
    try {
      await updateTeamDetails(tm.id, {
        name: editTeamName,
        description: tm.description || '',
        track: editTeamTrack,
        lookingForRoles: editTeamRoles.split(',').map((s) => s.trim()).filter(Boolean),
        status: tm.status
      });
      setEditingTeamId(null);
      await loadWorkspace();
      setFeedback(locale === 'ar' ? 'تم تحديث بيانات الفريق.' : 'Team details updated.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update team');
    } finally {
      setBusy(false);
    }
  };

  const handleLockTeam = async (tm: Team) => {
    if (!user || !emailVerified || tm.leaderId !== user.uid) return;
    setBusy(true);
    setErrorMsg('');
    try {
      await updateTeamDetails(tm.id, {
        name: tm.name,
        description: tm.description || '',
        track: tm.track || '',
        lookingForRoles: tm.lookingForRoles || [],
        status: 'locked'
      });
      await loadWorkspace();
      setFeedback(locale === 'ar' ? 'تم قفل تشكيلة الفريق.' : 'Team roster locked.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to lock team');
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveMember = async (tm: Team, targetUid: string) => {
    if (!user || !emailVerified || tm.leaderId !== user.uid || targetUid === tm.leaderId) return;
    setBusy(true);
    setErrorMsg('');
    try {
      await removeTeamMember(tm.id, targetUid);
      await loadWorkspace();
      setFeedback(locale === 'ar' ? 'تمت إزالة العضو من الفريق.' : 'Member removed from team.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to remove team member');
    } finally {
      setBusy(false);
    }
  };

  const handleLeaveTeam = async (tm: Team) => {
    if (!user || !emailVerified || tm.leaderId === user.uid) return;
    setBusy(true);
    setErrorMsg('');
    try {
      await leaveTeam(tm.id, user.uid);
      await loadWorkspace();
      setFeedback(locale === 'ar' ? `غادرت فريق "${tm.name}".` : `Left team "${tm.name}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to leave team');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTeam = async (tm: Team) => {
    if (!user || !emailVerified || tm.leaderId !== user.uid || tm.status !== 'forming') return;
    setBusy(true);
    setErrorMsg('');
    try {
      await deleteFormingTeam(tm.id);
      await loadWorkspace();
      setFeedback(locale === 'ar' ? `تم حذف الفريق "${tm.name}".` : `Forming team "${tm.name}" deleted.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to delete team');
    } finally {
      setBusy(false);
    }
  };

  const handleRotateJoinCode = async (teamId: string) => {
    if (!user || !emailVerified) return;
    setBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      const nextCode = await rotateTeamJoinCode(teamId);
      setLeaderJoinCodes((prev) => ({ ...prev, [teamId]: nextCode }));
      setLeaderCodeActive((prev) => ({ ...prev, [teamId]: true }));
      setFeedback(
        locale === 'ar'
          ? `تم إصدار رمز انضمام جديد قابل لإعادة الاستخدام (تم إبطال الرمز السابق): ${nextCode}`
          : `New reusable join code issued (previous code invalidated, never stored in plaintext): ${nextCode}`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to rotate join code');
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeJoinCode = async (teamId: string) => {
    if (!user || !emailVerified) return;
    setBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      await revokeTeamJoinCode(teamId);
      setLeaderJoinCodes((prev) => {
        const next = { ...prev };
        delete next[teamId];
        return next;
      });
      setLeaderCodeActive((prev) => ({ ...prev, [teamId]: false }));
      setFeedback(
        locale === 'ar'
          ? 'تم إبطال رمز الدعوة. يمكنك تدويره في أي وقت لإصدار رمز جديد.'
          : 'Team join code revoked. Rotate anytime to issue a new invite code.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to revoke join code');
    } finally {
      setBusy(false);
    }
  };

  const handleCopyJoinCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setFeedback(locale === 'ar' ? 'تم نسخ رمز الدعوة القابل لإعادة الاستخدام.' : 'Reusable invite code copied to clipboard.');
    } catch {
      setFeedback(`Invite code: ${code}`);
    }
  };

  const handleJoinByCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'يلزم حساب موثق البريد للانضمام إلى فريق.'
          : 'Verified account required to join a team.'
      );
      return;
    }
    setBusy(true);
    setErrorMsg('');
    setFeedback('');
    try {
      const joined = await joinTeamByCode(
        joinCodeInput,
        user.uid,
        profile?.displayName || user.displayName || 'Builder'
      );
      if (!joined) {
        setErrorMsg(
          locale === 'ar'
            ? 'لا يوجد فريق نشط يطابق رمز الانضمام المدخل.'
            : 'No active forming team matched that join code.'
        );
      } else {
        setJoinCodeInput('');
        await loadWorkspace();
        setFeedback(
          locale === 'ar'
            ? `تم الانضمام إلى فريق "${joined.name}" بنجاح.`
            : `Joined team "${joined.name}" successfully.`
        );
      }
    } catch (err) {
      setErrorMsg(formatActionableError(err, 'Failed to join team'));
    } finally {
      setBusy(false);
    }
  };

  const handleSaveProject = async (e: FormEvent) => {
    e.preventDefault();
    if (!user || !emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'يلزم حساب موثق البريد لحفظ المشروع.'
          : 'Verified account required to save a project.'
      );
      return;
    }
    const editingExisting = editingProjectId
      ? projects.find((p) => p.id === editingProjectId)
      : undefined;
    const team = teams.find((tm) => tm.id === (editingExisting?.teamId || selectedTeamId));
    if (!team && !editingExisting) {
      setErrorMsg(
        locale === 'ar'
          ? 'أنشئ فريقاً أو انضم إلى فريق قبل إنشاء مشروع.'
          : 'Create or join a team before creating a project.'
      );
      return;
    }
    setBusy(true);
    setErrorMsg('');
    try {
      const targetId = editingExisting?.id || generateFirestoreId('proj');
      const payload: Omit<Project, 'createdAt' | 'updatedAt'> = {
        id: targetId,
        hackathonId: editingExisting?.hackathonId || team!.hackathonId,
        organizerId: editingExisting?.organizerId || team!.organizerId,
        teamId: editingExisting?.teamId || team!.id,
        ownerId: editingExisting?.ownerId || user.uid,
        memberIds: editingExisting?.memberIds || team!.memberIds,
        title: projectTitle,
        problemStatement,
        proposedSolution,
        targetUsers,
        technologies: techText.split(',').map((s) => s.trim()).filter(Boolean),
        roadmap: editingExisting?.roadmap || [],
        tasks: editingExisting?.tasks || [],
        notes: projectNotes,
        aiMentorApprovedSummary: editingExisting?.aiMentorApprovedSummary || '',
        status: projectStatus
      };
      await saveProject(payload, !editingExisting);
      resetProjectForm();
      await loadWorkspace();
      setActiveProject(payload);
      setFeedback(
        editingExisting
          ? locale === 'ar'
            ? 'تم تحديث بيانات المشروع.'
            : 'Project workspace updated.'
          : locale === 'ar'
            ? 'تم إنشاء مساحة المشروع.'
            : 'Project workspace created.'
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save project');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteProject = async (p: Project) => {
    if (!user || !emailVerified || p.ownerId !== user.uid || p.status === 'submitted') return;
    setBusy(true);
    setErrorMsg('');
    try {
      await deleteProject(p.id);
      if (editingProjectId === p.id) resetProjectForm();
      if (activeProject?.id === p.id) setActiveProject(null);
      await loadWorkspace();
      setFeedback(locale === 'ar' ? 'تم حذف المشروع.' : 'Project deleted.');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to delete project');
    } finally {
      setBusy(false);
    }
  };

  const handleAddTask = async () => {
    if (!user || !emailVerified) {
      setErrorMsg(
        locale === 'ar'
          ? 'يلزم حساب موثق لإضافة المهام.'
          : 'Verified account required to add tasks.'
      );
      return;
    }
    if (!activeProject || !newTaskTitle.trim()) return;
    const task: ProjectTask = {
      id: generateFirestoreId('tsk'),
      title: newTaskTitle.trim(),
      assigneeName: profile?.displayName || 'Team',
      status: 'todo',
      dueDate: ''
    };
    const updated = { ...activeProject, tasks: [...(activeProject.tasks || []), task] };
    setBusy(true);
    setErrorMsg('');
    try {
      await saveProject(updated, false);
      setActiveProject(updated);
      setNewTaskTitle('');
      await loadWorkspace();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save task');
    } finally {
      setBusy(false);
    }
  };

  const toggleTaskStatus = async (taskId: string) => {
    if (!user || !emailVerified || !activeProject) {
      setErrorMsg(
        locale === 'ar'
          ? 'يلزم حساب موثق لتحديث حالة المهام.'
          : 'Verified account required to update tasks.'
      );
      return;
    }
    const nextOrder: Record<ProjectTask['status'], ProjectTask['status']> = {
      todo: 'in_progress',
      in_progress: 'done',
      done: 'todo'
    };
    const nextTasks = (activeProject.tasks || []).map((tsk) =>
      tsk.id === taskId ? { ...tsk, status: nextOrder[tsk.status] } : tsk
    );
    const updated = { ...activeProject, tasks: nextTasks };
    setBusy(true);
    setErrorMsg('');
    try {
      await saveProject(updated, false);
      setActiveProject(updated);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to update task status');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
          {t.sidebar.builder}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {locale === 'ar'
            ? 'أدر تسجيلاتك، كوّن فريقك أو انضم برمز دعوة، ونظّم مهام مشروعك.'
            : 'Manage hackathon registrations, team formation, and project tasks.'}
        </p>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-700 dark:text-red-300">
          {errorMsg}
        </div>
      )}
      {feedback && (
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3 text-xs text-emerald-700 dark:text-emerald-300">
          {feedback}
        </div>
      )}

      {user && (
        <RegistrationDiagnosticPanel
          user={user}
          emailVerified={emailVerified}
          selectedHackathonId={teamHackathonId}
          selectedHackathon={hackathons.find((h) => h.id === teamHackathonId)}
          builderStateRegistrations={registrations}
        />
      )}

      {/* Registrations + Team Formation */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 space-y-6">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-3">
            {(() => {
              const resolvedRegistrations = Array.from(
                indexRegistrationsByHackathon(registrations, user?.uid).values()
              );
              return (
                <>
                  <h2 className="font-display text-base font-semibold">
                    {locale === 'ar' ? 'الهاكاثونات المسجل بها' : 'Registered Hackathons'} (
                    {resolvedRegistrations.length})
                  </h2>
                  {resolvedRegistrations.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      {locale === 'ar'
                        ? 'لا توجد تسجيلات بعد. انتقل إلى استكشاف الهاكاثونات للتسجيل.'
                        : 'No registrations yet. Visit Discover Hackathons to register for a competition.'}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {resolvedRegistrations.map((reg) => {
                        const h = hackathons.find((x) => x.id === reg.hackathonId);
                        const isConfirming = confirmWithdrawRegId === reg.id;
                        return (
                          <div
                            key={reg.id}
                            className="rounded-lg border border-slate-200 dark:border-slate-800 p-3 text-xs space-y-1.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold">{h?.title || reg.hackathonId}</span>
                              <span className="capitalize text-blue-500 font-medium">{reg.status}</span>
                            </div>
                            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                              <span>{reg.preferredTrack}</span>
                              <div className="flex gap-2">
                                {reg.status === 'pending' &&
                                  emailVerified &&
                                  (!h || (h.status === 'published' && !isDeadlinePassed(h.registrationDeadline))) && (
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => void handleConfirmPendingReg(reg)}
                                      className="text-emerald-600 dark:text-emerald-400 font-semibold hover:underline"
                                    >
                                      {locale === 'ar' ? 'تأكيد وتفعيل' : 'Confirm'}
                                    </button>
                                  )}
                                {(reg.status === 'pending' || reg.status === 'approved') &&
                                  !isConfirming && (
                                    <button
                                      type="button"
                                      disabled={busy}
                                      onClick={() => setConfirmWithdrawRegId(reg.id)}
                                      className="text-amber-600 dark:text-amber-400 hover:underline"
                                    >
                                      {locale === 'ar' ? 'سحب' : 'Withdraw'}
                                    </button>
                                  )}
                                {(reg.status === 'pending' || reg.status === 'withdrawn') && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleDeleteReg(reg)}
                                    className="text-red-500 hover:underline"
                                  >
                                    {t.common.delete}
                                  </button>
                                )}
                              </div>
                            </div>
                            {isConfirming && (
                              <div className="rounded border border-amber-500/50 bg-amber-500/10 p-2 text-[11px] text-amber-900 dark:text-amber-200 space-y-1.5">
                                <div>
                                  {reg.status === 'approved'
                                    ? locale === 'ar'
                                      ? 'تأكيد سحب التسجيل المقبول؟ ستفقد أهلية إنشاء فريق حتى إعادة التقديم قبل انتهاء الموعد.'
                                      : 'Confirm withdrawing this approved registration? You will lose team creation eligibility until you re-apply before the deadline.'
                                    : locale === 'ar'
                                      ? 'تأكيد سحب هذا التسجيل؟'
                                      : 'Confirm withdrawing this registration?'}
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleWithdrawReg(reg)}
                                    className="rounded bg-amber-600 px-2 py-0.5 font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
                                  >
                                    {locale === 'ar' ? 'تأكيد السحب' : 'Confirm Withdraw'}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => setConfirmWithdrawRegId(null)}
                                    className="rounded border border-slate-300 dark:border-slate-700 px-2 py-0.5 font-semibold text-slate-700 dark:text-slate-200"
                                  >
                                    {t.common.cancel}
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          <form
            onSubmit={(e) => void handleCreateTeam(e)}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-3"
          >
            <h2 className="font-display text-base font-semibold flex items-center gap-2">
              <Users className="h-4 w-4 text-blue-500" />
              <span>{locale === 'ar' ? 'إنشاء فريق جديد' : 'Create a Team'}</span>
            </h2>
            {(() => {
              const regByHackathon = indexRegistrationsByHackathon(registrations, user?.uid);
              const selectedHack = hackathons.find((h) => h.id === teamHackathonId);
              const selectedReg = teamHackathonId
                ? selectPreferredRegistration(registrations, teamHackathonId, user?.uid)
                : null;
              const isSelectedApproved = selectedReg?.status === 'approved';
              const isSelectedPendingEligible = Boolean(
                selectedReg?.status === 'pending' &&
                  selectedHack &&
                  selectedHack.status === 'published' &&
                  !isDeadlinePassed(selectedHack.registrationDeadline)
              );
              const canCreateTeam = Boolean(
                teamHackathonId &&
                  (isSelectedApproved || isSelectedPendingEligible) &&
                  emailVerified
              );

              return (
                <>
                  <select
                    value={teamHackathonId}
                    onChange={(e) => setTeamHackathonId(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
                  >
                    {hackathons.map((h) => {
                      const reg = regByHackathon.get(h.id);
                      const statusLabel = reg
                        ? reg.status === 'approved'
                          ? (locale === 'ar' ? ' (مقبول)' : ' (Approved)')
                          : reg.status === 'pending'
                            ? (locale === 'ar' ? ' (بانتظار التأكيد)' : ' (Pending Confirmation)')
                            : reg.status === 'rejected'
                              ? (locale === 'ar' ? ' (مرفوض)' : ' (Rejected)')
                              : (locale === 'ar' ? ' (منسحب)' : ' (Withdrawn)')
                        : (locale === 'ar' ? ' (غير مسجل)' : ' (Not Registered)');
                      return (
                        <option key={h.id} value={h.id}>
                          {h.title}{statusLabel}
                        </option>
                      );
                    })}
                  </select>

                  {teamHackathonId && !emailVerified && (
                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-800 dark:text-amber-200">
                      {locale === 'ar'
                        ? 'يرجى تأكيد بريدك الإلكتروني لتمكين إنشاء الفريق.'
                        : 'Verify your email address before creating a team.'}
                    </div>
                  )}

                  {teamHackathonId && emailVerified && isSelectedApproved && (
                    <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-2 text-[11px] font-medium text-emerald-800 dark:text-emerald-200">
                      {locale === 'ar'
                        ? 'تمت الموافقة — إنشاء الفريق متاح'
                        : 'Approved — Team creation enabled'}
                    </div>
                  )}

                  {teamHackathonId && emailVerified && !isSelectedApproved && (
                    <div
                      className={`rounded-lg border p-2 text-[11px] space-y-1.5 ${
                        selectedReg?.status === 'rejected'
                          ? 'border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200'
                          : 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'
                      }`}
                    >
                      <div>
                        {selectedReg?.status === 'pending'
                          ? isSelectedPendingEligible
                            ? locale === 'ar'
                              ? 'تسجيلك قيد الانتظار. اضغط أدناه لتأكيده فوراً أو أرسل النموذج لتفعيله وإنشاء الفريق تلقائياً.'
                              : 'Your registration is still pending. Confirm below or submit this form to activate it immediately and create your team.'
                            : locale === 'ar'
                              ? 'تسجيلك معلق وقد انتهى الموعد النهائي للتسجيل في هذا الهاكاثون.'
                              : 'Your registration is pending and the registration deadline for this hackathon has passed.'
                          : selectedReg?.status === 'rejected'
                            ? locale === 'ar'
                              ? 'تم رفض تسجيلك في هذا الهاكاثون من قِبل المنظم.'
                              : 'Your registration for this hackathon was rejected by the organizer.'
                            : selectedReg?.status === 'withdrawn'
                              ? locale === 'ar'
                                ? 'تم سحب تسجيلك. أعد التقديم في صفحة استكشاف الهاكاثونات قبل انتهاء الموعد.'
                                : 'Your registration was withdrawn. Re-apply in Discover Hackathons before the deadline to unlock team creation.'
                              : locale === 'ar'
                                ? 'أنت غير مسجل في هذا الهاكاثون بعد. سجّل من صفحة استكشاف الهاكاثونات لتفعيل إنشاء الفريق فوراً.'
                                : 'Not registered for this hackathon yet. Register in Discover Hackathons to unlock team creation immediately.'}
                      </div>
                      {selectedReg?.status === 'pending' && isSelectedPendingEligible && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleConfirmPendingReg(selectedReg)}
                          className="rounded bg-emerald-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {locale === 'ar' ? 'تأكيد وتفعيل التسجيل' : 'Confirm & Activate Registration'}
                        </button>
                      )}
                    </div>
                  )}

                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={80}
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    placeholder={locale === 'ar' ? 'اسم الفريق' : 'Team name'}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
                  />
                  <input
                    type="text"
                    value={teamTrack}
                    onChange={(e) => setTeamTrack(e.target.value)}
                    placeholder={locale === 'ar' ? 'المسار (اختياري)' : 'Track (optional)'}
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
                  />
                  <input
                    type="text"
                    value={lookingRoles}
                    onChange={(e) => setLookingRoles(e.target.value)}
                    placeholder={
                      locale === 'ar'
                        ? 'الأدوار المطلوبة (مفصولة بفاصلة)'
                        : 'Looking for roles (comma-separated)'
                    }
                    className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
                  />
                  <button
                    type="submit"
                    disabled={busy || !canCreateTeam}
                    className="w-full rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {locale === 'ar' ? 'إنشاء الفريق' : 'Create Team'}
                  </button>
                </>
              );
            })()}
          </form>

          <form
            onSubmit={(e) => void handleJoinByCode(e)}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-3"
          >
            <h2 className="font-display text-sm font-semibold">
              {locale === 'ar' ? 'الانضمام لفريق برمز الدعوة' : 'Join Team by Code'}
            </h2>
            <div className="flex gap-2">
              <input
                type="text"
                required
                value={joinCodeInput}
                onChange={(e) => setJoinCodeInput(e.target.value)}
                placeholder="HM-XXXXX"
                className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm font-mono uppercase"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded-lg border border-slate-300 dark:border-slate-700 px-4 py-2 text-xs font-semibold"
              >
                {locale === 'ar' ? 'انضمام' : 'Join'}
              </button>
            </div>
          </form>
        </div>

        {/* Right column: My Teams + Project Workspace */}
        <div className="lg:col-span-7 space-y-6">
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-3">
            <h2 className="font-display text-base font-semibold">
              {locale === 'ar' ? 'فرقي' : 'My Teams'} ({teams.length})
            </h2>
            {teams.length === 0 ? (
              <p className="text-xs text-slate-500">
                {locale === 'ar' ? 'لست منضماً إلى أي فريق بعد.' : 'You are not in a team yet.'}
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-3">
                {teams.map((tm) => {
                  const isLeader = tm.leaderId === user?.uid;
                  const ephemCode = leaderJoinCodes[tm.id];
                  const codeActive = Boolean(leaderCodeActive[tm.id]);
                  const roster = teamMembersMap[tm.id] || [];
                  const isEditingThisTeam = editingTeamId === tm.id;
                  return (
                    <div
                      key={tm.id}
                      className="rounded-lg border border-slate-200 dark:border-slate-800 p-4 space-y-2.5 text-xs"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <span className="font-semibold text-sm text-slate-900 dark:text-white">
                            {tm.name}
                          </span>{' '}
                          <span className="font-mono text-[11px] uppercase text-blue-500">
                            ({tm.status})
                          </span>
                        </div>
                        {isLeader ? (
                          <span
                            className={`text-[11px] font-medium ${codeActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-400'}`}
                          >
                            {codeActive
                              ? locale === 'ar'
                                ? 'رمز الدعوة نشط'
                                : 'Invite code active'
                              : locale === 'ar'
                                ? 'رمز الدعوة معطّل'
                                : 'Invite code revoked'}
                          </span>
                        ) : (
                          <span className="text-[11px] text-slate-400">
                            {locale === 'ar' ? 'الرمز لدى قائد الفريق' : 'Leader-only code'}
                          </span>
                        )}
                      </div>

                      <div className="text-slate-500">
                        {locale === 'ar' ? 'المسار:' : 'Track:'} {tm.track || 'General'} ·{' '}
                        {locale === 'ar' ? 'الأعضاء:' : 'Members:'}{' '}
                        {tm.memberIds.length}
                      </div>

                      {/* Member Roster */}
                      <div className="flex flex-wrap gap-2">
                        {roster.length > 0
                          ? roster.map((m) => (
                              <div
                                key={m.uid}
                                className="inline-flex items-center gap-1.5 rounded border border-slate-200 dark:border-slate-700 px-2 py-1"
                              >
                                <span className="font-medium text-slate-800 dark:text-slate-200">
                                  {m.displayName}
                                </span>
                                <span className="text-[10px] text-slate-400">({m.roleInTeam})</span>
                                {isLeader && m.uid !== tm.leaderId && (
                                  <button
                                    type="button"
                                    disabled={busy}
                                    onClick={() => void handleRemoveMember(tm, m.uid)}
                                    title={locale === 'ar' ? 'إزالة العضو' : 'Remove member'}
                                    className="text-red-500 hover:text-red-600"
                                  >
                                    <UserMinus className="h-3 w-3" />
                                  </button>
                                )}
                              </div>
                            ))
                          : (tm.memberNames || []).map((name, i) => (
                              <span
                                key={`${name}-${i}`}
                                className="rounded border border-slate-200 dark:border-slate-700 px-2 py-0.5"
                              >
                                {name}
                              </span>
                            ))}
                      </div>

                      {isEditingThisTeam && isLeader && (
                        <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3 space-y-2">
                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                            <input
                              type="text"
                              value={editTeamName}
                              onChange={(e) => setEditTeamName(e.target.value)}
                              placeholder={locale === 'ar' ? 'اسم الفريق' : 'Team name'}
                              className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2 py-1 text-xs"
                            />
                            <input
                              type="text"
                              value={editTeamTrack}
                              onChange={(e) => setEditTeamTrack(e.target.value)}
                              placeholder={locale === 'ar' ? 'المسار' : 'Track'}
                              className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2 py-1 text-xs"
                            />
                            <input
                              type="text"
                              value={editTeamRoles}
                              onChange={(e) => setEditTeamRoles(e.target.value)}
                              placeholder={locale === 'ar' ? 'الأدوار المطلوبة' : 'Looking for roles'}
                              className="rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2 py-1 text-xs"
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setEditingTeamId(null)}
                              className="rounded border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-[11px]"
                            >
                              {t.common.cancel}
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleSaveTeamEdit(tm)}
                              className="rounded bg-blue-600 px-3 py-1 text-[11px] font-semibold text-white"
                            >
                              {t.common.save}
                            </button>
                          </div>
                        </div>
                      )}

                      {isLeader ? (
                        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-1.5">
                          {ephemCode && (
                            <div className="flex items-center justify-between gap-2 rounded bg-slate-50 dark:bg-slate-900 px-2 py-1">
                              <span
                                className="font-mono text-[11px] text-blue-500 truncate"
                                title={ephemCode}
                              >
                                {ephemCode}
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleCopyJoinCode(ephemCode)}
                                className="inline-flex items-center gap-1 text-[11px] text-slate-600 dark:text-slate-300 hover:text-blue-500"
                              >
                                <Copy className="h-3 w-3" />
                                <span>{locale === 'ar' ? 'نسخ' : 'Copy'}</span>
                              </button>
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void handleRotateJoinCode(tm.id)}
                              className="inline-flex items-center gap-1 rounded border border-slate-300 dark:border-slate-700 px-2 py-1 text-[11px] font-medium hover:bg-slate-50 dark:hover:bg-slate-900 disabled:opacity-50"
                            >
                              <RefreshCw className="h-3 w-3" />
                              <span>{locale === 'ar' ? 'تدوير الرمز' : 'Rotate Code'}</span>
                            </button>
                            {codeActive && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void handleRevokeJoinCode(tm.id)}
                                className="inline-flex items-center gap-1 rounded border border-red-300 dark:border-red-800/60 px-2 py-1 text-[11px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
                              >
                                <ShieldOff className="h-3 w-3" />
                                <span>{locale === 'ar' ? 'إبطال' : 'Revoke'}</span>
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                setEditingTeamId(tm.id);
                                setEditTeamName(tm.name);
                                setEditTeamTrack(tm.track || '');
                                setEditTeamRoles((tm.lookingForRoles || []).join(', '));
                              }}
                              className="inline-flex items-center gap-1 rounded border border-slate-300 dark:border-slate-700 px-2 py-1 text-[11px] font-medium"
                            >
                              <Edit3 className="h-3 w-3" />
                              <span>{t.common.edit}</span>
                            </button>
                            {tm.status === 'forming' && (
                              <>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleLockTeam(tm)}
                                  className="inline-flex items-center gap-1 rounded border border-amber-500/40 px-2 py-1 text-[11px] font-medium text-amber-600 dark:text-amber-300"
                                >
                                  <Lock className="h-3 w-3" />
                                  <span>{locale === 'ar' ? 'قفل التشكيلة' : 'Lock Team'}</span>
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void handleDeleteTeam(tm)}
                                  className="inline-flex items-center gap-1 rounded border border-red-500/40 px-2 py-1 text-[11px] font-medium text-red-600 dark:text-red-400"
                                >
                                  <Trash2 className="h-3 w-3" />
                                  <span>{t.common.delete}</span>
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      ) : (
                        <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex justify-end">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleLeaveTeam(tm)}
                            className="inline-flex items-center gap-1 rounded border border-red-500/40 px-2.5 py-1 text-[11px] font-medium text-red-600 dark:text-red-400"
                          >
                            <LogOut className="h-3 w-3" />
                            <span>{locale === 'ar' ? 'مغادرة الفريق' : 'Leave Team'}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => void handleSaveProject(e)}
            className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base font-semibold">
                {editingProjectId
                  ? locale === 'ar'
                    ? 'تعديل المشروع'
                    : 'Edit Team Project'
                  : locale === 'ar'
                    ? 'إنشاء مشروع الفريق'
                    : 'Create Team Project'}
              </h2>
              {editingProjectId && (
                <button
                  type="button"
                  onClick={resetProjectForm}
                  className="rounded border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs"
                >
                  {locale === 'ar' ? 'مشروع جديد' : 'New Project'}
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <select
                value={selectedTeamId}
                disabled={Boolean(editingProjectId)}
                onChange={(e) => setSelectedTeamId(e.target.value)}
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs disabled:opacity-60"
              >
                <option value="">{locale === 'ar' ? 'اختر فريقاً...' : 'Select team...'}</option>
                {teams.map((tm) => (
                  <option key={tm.id} value={tm.id}>
                    {tm.name}
                  </option>
                ))}
              </select>
              <input
                type="text"
                required
                minLength={2}
                value={projectTitle}
                onChange={(e) => setProjectTitle(e.target.value)}
                placeholder={locale === 'ar' ? 'عنوان المشروع' : 'Project title'}
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-sm"
              />
              <select
                value={projectStatus}
                onChange={(e) => setProjectStatus(e.target.value as 'ideation' | 'building')}
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
              >
                <option value="ideation">{locale === 'ar' ? 'بلورة الفكرة' : 'Ideation'}</option>
                <option value="building">{locale === 'ar' ? 'قيد البناء' : 'Building'}</option>
              </select>
            </div>
            <textarea
              rows={2}
              value={problemStatement}
              onChange={(e) => setProblemStatement(e.target.value)}
              placeholder={locale === 'ar' ? 'وصف المشكلة' : 'Problem statement'}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
            />
            <textarea
              rows={2}
              value={proposedSolution}
              onChange={(e) => setProposedSolution(e.target.value)}
              placeholder={locale === 'ar' ? 'الحل المقترح' : 'Proposed solution'}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                value={targetUsers}
                onChange={(e) => setTargetUsers(e.target.value)}
                placeholder={locale === 'ar' ? 'الفئة المستهدفة' : 'Target users'}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
              />
              <input
                type="text"
                value={techText}
                onChange={(e) => setTechText(e.target.value)}
                placeholder={
                  locale === 'ar'
                    ? 'التقنيات (مفصولة بفاصلة)'
                    : 'Technologies (comma-separated)'
                }
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
              />
            </div>
            <textarea
              rows={2}
              value={projectNotes}
              onChange={(e) => setProjectNotes(e.target.value)}
              placeholder={locale === 'ar' ? 'ملاحظات التنفيذ أو المعمارية' : 'Architecture & engineering notes'}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-2 text-xs"
            />
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {editingProjectId
                ? locale === 'ar'
                  ? 'تحديث المشروع'
                  : 'Update Project'
                : locale === 'ar'
                  ? 'حفظ المشروع'
                  : 'Save Project'}
            </button>
          </form>

          {/* Active Project Tasks & AI Approved Notes */}
          {projects.length > 0 && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0B1120] p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-display text-base font-semibold flex items-center gap-2">
                  <CheckSquare className="h-4 w-4 text-blue-500" />
                  <span>
                    {locale === 'ar' ? 'مهام المشروع ومعالمه' : 'Project Tasks & Milestones'}
                  </span>
                </h2>
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={activeProject?.id || ''}
                    onChange={(e) =>
                      setActiveProject(projects.find((p) => p.id === e.target.value) || null)
                    }
                    className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-2.5 py-1.5 text-xs"
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                  {activeProject && (
                    <>
                      <button
                        type="button"
                        onClick={() => loadProjectIntoForm(activeProject)}
                        className="rounded border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs"
                      >
                        {t.common.edit}
                      </button>
                      {activeProject.ownerId === user?.uid && activeProject.status !== 'submitted' && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDeleteProject(activeProject)}
                          className="rounded border border-red-500/40 px-2.5 py-1 text-xs text-red-600 dark:text-red-400"
                        >
                          {t.common.delete}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {activeProject && (
                <>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                      placeholder={locale === 'ar' ? 'أضف مهمة...' : 'Add task...'}
                      className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-[#070B14] px-3 py-1.5 text-xs"
                    />
                    <button
                      type="button"
                      onClick={() => void handleAddTask()}
                      className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      <span>{locale === 'ar' ? 'إضافة' : 'Add'}</span>
                    </button>
                  </div>

                  <div className="space-y-2">
                    {(activeProject.tasks || []).length === 0 ? (
                      <p className="text-xs text-slate-500">
                        {locale === 'ar'
                          ? 'لا توجد مهام بعد. أضف مهمة أو أنشئ خارطة طريق عبر المرشد الذكي.'
                          : 'No tasks yet. Add tasks or generate a roadmap in AI Mentor.'}
                      </p>
                    ) : (
                      (activeProject.tasks || []).map((tsk) => (
                        <button
                          key={tsk.id}
                          type="button"
                          onClick={() => void toggleTaskStatus(tsk.id)}
                          className="w-full flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 px-3 py-2 text-xs text-start hover:bg-slate-50 dark:hover:bg-slate-900"
                        >
                          <span className={tsk.status === 'done' ? 'line-through text-slate-400' : ''}>
                            {tsk.title}
                          </span>
                          <span className="font-mono capitalize text-blue-500">
                            {tsk.status.replace('_', ' ')}
                          </span>
                        </button>
                      ))
                    )}
                  </div>

                  {activeProject.aiMentorApprovedSummary && (
                    <div className="border-t border-slate-200 dark:border-slate-800 pt-3 text-xs space-y-1">
                      <div className="font-semibold">
                        {locale === 'ar' ? 'خطة المرشد الذكي المعتمدة' : 'Approved AI Mentor Plan'}
                      </div>
                      <p className="text-slate-600 dark:text-slate-300 whitespace-pre-line">
                        {activeProject.aiMentorApprovedSummary}
                      </p>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
