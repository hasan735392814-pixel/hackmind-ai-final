import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const rootDir = process.cwd();
const srcDir = path.join(rootDir, 'src');

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (/\.(ts|tsx|html)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('Application-Wide Static Image & Asset Bundling Audit', () => {
  it('never references unbundled literal /src/assets/ paths in src or index.html', () => {
    const files = [...collectSourceFiles(srcDir), path.join(rootDir, 'index.html')];
    const offending: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      if (content.includes('/src/assets/')) {
        offending.push(path.relative(rootDir, file));
      }
    }
    expect(offending).toEqual([]);
  });

  it('includes all referenced local image files on disk with valid non-empty bytes', () => {
    const expectedImages = [
      'src/assets/images/hero_hackmind_workspace_1794769584396.jpg',
      'src/assets/images/hackathon_edge_ai_1794769584219.jpg',
      'src/assets/images/hackathon_judging_review_1794769585505.jpg'
    ];
    for (const rel of expectedImages) {
      const full = path.join(rootDir, rel);
      expect(fs.existsSync(full)).toBe(true);
      const stat = fs.statSync(full);
      expect(stat.size).toBeGreaterThan(10_000);
    }
  });

  it('uses static ES module imports and SafeImage in LandingPage.tsx', () => {
    const landingCode = fs.readFileSync(path.join(srcDir, 'pages', 'LandingPage.tsx'), 'utf8');
    expect(landingCode).toContain("import heroWorkspaceImg from '../assets/images/hero_hackmind_workspace_1794769584396.jpg'");
    expect(landingCode).toContain("import edgeAiWorkstationImg from '../assets/images/hackathon_edge_ai_1794769584219.jpg'");
    expect(landingCode).toContain("import judgingReviewImg from '../assets/images/hackathon_judging_review_1794769585505.jpg'");
    expect(landingCode).toContain('<SafeImage');
  });
});
