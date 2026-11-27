import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { LanguageProvider } from './contexts/LanguageContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { DashboardLayout } from './layouts/DashboardLayout';
import { LandingPage } from './pages/LandingPage';
import { AuthPage } from './pages/AuthPage';
import { OverviewDashboard } from './pages/OverviewDashboard';
import { DiscoveryPage } from './pages/DiscoveryPage';
import { OrganizerStudioPage } from './pages/OrganizerStudioPage';
import { BuilderWorkspacePage } from './pages/BuilderWorkspacePage';
import { TeamsMatchingPage } from './pages/TeamsMatchingPage';
import { AIMentorPage } from './pages/AIMentorPage';
import { SubmissionsPage } from './pages/SubmissionsPage';
import { EvidenceJudgingPage } from './pages/EvidenceJudgingPage';
import { SponsorAnalyticsPage } from './pages/SponsorAnalyticsPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { ProfilePage } from './pages/ProfilePage';

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-[#070B14] flex items-center justify-center text-sm text-slate-500">
        Loading workspace...
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/auth" replace />;
  }
  return <DashboardLayout>{children}</DashboardLayout>;
}

export default function App() {
  return (
    <ThemeProvider>
      <LanguageProvider>
        <AuthProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/auth" element={<AuthPage />} />
              <Route
                path="/app"
                element={
                  <ProtectedRoute>
                    <OverviewDashboard />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app/discover"
                element={
                  <ProtectedRoute>
                    <DiscoveryPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app/organizer"
                element={
                  <ProtectedRoute>
                    <OrganizerStudioPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app/builder"
                element={
                  <ProtectedRoute>
                    <BuilderWorkspacePage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app/teams"
                element={
                  <ProtectedRoute>
                    <TeamsMatchingPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app/mentor"
                element={
                  <ProtectedRoute>
                    <AIMentorPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app/submissions"
                element={
                  <ProtectedRoute>
                    <SubmissionsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app/judging"
                element={<Navigate to="/app/judging-v2" replace />}
              />
              <Route
                path="/app/judging-v2"
                element={
                  <ProtectedRoute>
                    <EvidenceJudgingPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app/sponsors"
                element={
                  <ProtectedRoute>
                    <SponsorAnalyticsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app/diagnostics"
                element={
                  <ProtectedRoute>
                    <DiagnosticsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app/notifications"
                element={
                  <ProtectedRoute>
                    <NotificationsPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/app/profile"
                element={
                  <ProtectedRoute>
                    <ProfilePage />
                  </ProtectedRoute>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
}
