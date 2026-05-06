//-------------------------//
// App.tsx
// Code implemented by Cirface.com / MMG
//
// Root component. Owns all wizard state and drives step progression.
// Auth state is checked on mount; unauthenticated users see the Login screen.
//
// Disclaimer: This code was created with the help of Claude.AI
//
// This code is part of Cirface Migration Tool
// Last updated by: 2026MAR11 - LMR
//-------------------------//

import { useEffect, useReducer } from 'react';
import Login from './components/Login.tsx';
import StepIndicator from './components/shared/StepIndicator.tsx';
import ConnectSources from './components/steps/ConnectSources.tsx';
import TrackingProject from './components/steps/TrackingProject.tsx';
import UserMapping from './components/steps/UserMapping.tsx';
import SelectProjects from './components/steps/SelectProjects.tsx';
import FieldMapping from './components/steps/FieldMapping.tsx';
import ReviewConfirm from './components/steps/ReviewConfirm.tsx';
import RunMigration from './components/steps/RunMigration.tsx';
import Report from './components/steps/Report.tsx';
import AnalyzeSelectProjects from './components/steps/AnalyzeSelectProjects.tsx';
import RunAnalysis from './components/steps/RunAnalysis.tsx';
import AnalysisReport from './components/steps/AnalysisReport.tsx';
import type {
  AnalysisReport as AnalysisReportType,
  FieldMappingEntry,
  MigrationReport,
  SectionMappingEntry,
  SourcePlatform,
  UserMappingEntry,
} from './types/index.ts';

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------

export type WizardStep =
  | 'connect'
  | 'tracking'
  | 'user-mapping'
  | 'select-projects'
  | 'field-mapping'
  | 'review'
  | 'running'
  | 'report'
  | 'analyze-select'
  | 'analyzing'
  | 'analysis-report';

export type AppMode = 'migrate' | 'analyze';

const MIGRATE_STEPS: WizardStep[] = [
  'connect',
  'tracking',
  'user-mapping',
  'select-projects',
  'field-mapping',
  'review',
  'running',
  'report',
];

const ANALYZE_STEPS: WizardStep[] = [
  'connect',
  'tracking',
  'analyze-select',
  'analyzing',
  'analysis-report',
];

const STEP_LABELS: Record<WizardStep, string> = {
  'connect': 'Connect',
  'tracking': 'Tracking',
  'user-mapping': 'Users',
  'select-projects': 'Projects',
  'field-mapping': 'Mapping',
  'review': 'Review',
  'running': 'Migrate',
  'report': 'Report',
  'analyze-select': 'Projects',
  'analyzing': 'Analyze',
  'analysis-report': 'Report',
};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

export interface AppState {
  authChecked: boolean;
  authenticated: boolean;
  user: { name: string; email: string } | null;
  appEnv: string;

  mode: AppMode;
  step: WizardStep;

  // Connect step
  sourcePlatform: SourcePlatform | null;
  sourceConnected: boolean;
  sourceWorkspaceName: string | null;
  destConnected: boolean;
  destWorkspaceName: string | null;
  destWorkspaceGid: string | null;

  // Tracking
  trackingProjectGid: string | null;
  trackingProjectName: string | null;
  trackingPortfolioGid: string | null;
  trackingPortfolioName: string | null;
  trackingOwnerGid: string | null;
  trackingOwnerName: string | null;

  // User mapping
  userMapping: UserMappingEntry[];

  // Project selection (migrate mode — single project)
  selectedSourceProjectId: string | null;
  selectedSourceProjectName: string | null;
  selectedDestProjectGid: string | null;
  selectedDestProjectName: string | null;
  selectedDestTeamGid: string | null;
  selectedDestTeamName: string | null;
  isNewDestProject: boolean;
  projectOwnerGid: string | null;
  projectOwnerName: string | null;

  // Field mapping
  fieldMapping: FieldMappingEntry[];
  sectionMapping: SectionMappingEntry[];
  externalIdDestFieldGid: string | null;

  // Analyze mode — multi-project selection
  analyzeProjectIds: Array<{ id: string; name: string }>;

  // Reports
  lastReport: MigrationReport | null;
  analysisReport: AnalysisReportType | null;
}

type Action =
  | { type: 'AUTH_CHECKED'; authenticated: boolean; user: AppState['user']; appEnv: string }
  | { type: 'LOGGED_OUT' }
  | { type: 'SET_MODE'; mode: AppMode }
  | { type: 'SET_STEP'; step: WizardStep }
  | { type: 'SOURCE_CONNECTED'; platform: SourcePlatform; workspaceName: string }
  | { type: 'DEST_CONNECTED'; workspaceGid: string; workspaceName: string }
  | { type: 'SET_TRACKING'; gid: string; name: string; portfolioGid: string | null; portfolioName: string | null; ownerGid: string | null; ownerName: string | null }
  | { type: 'SET_USER_MAPPING'; mapping: UserMappingEntry[] }
  | { type: 'SET_PROJECT_SELECTION'; sourceId: string; sourceName: string; destGid: string; destName: string; teamGid: string | null; teamName: string | null; isNew: boolean; ownerGid: string | null; ownerName: string | null }
  | { type: 'SET_FIELD_MAPPING'; mapping: FieldMappingEntry[]; sectionMapping: SectionMappingEntry[]; externalIdDestFieldGid: string | null }
  | { type: 'MIGRATION_COMPLETE'; report: MigrationReport }
  | { type: 'RUN_ANOTHER' }
  | { type: 'RELOAD_MAPPING' }
  | { type: 'SET_ANALYZE_PROJECTS'; projects: Array<{ id: string; name: string }> }
  | { type: 'ANALYSIS_COMPLETE'; report: AnalysisReportType }
  | { type: 'RUN_ANOTHER_ANALYSIS' };

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'AUTH_CHECKED':
      return {
        ...state,
        authChecked: true,
        authenticated: action.authenticated,
        user: action.user,
        appEnv: action.appEnv,
        step: action.authenticated ? 'connect' : state.step,
      };
    case 'LOGGED_OUT':
      return { ...initialState, authChecked: true, authenticated: false };
    case 'SET_MODE':
      return { ...state, mode: action.mode };
    case 'SET_STEP':
      return { ...state, step: action.step };
    case 'SOURCE_CONNECTED':
      return { ...state, sourcePlatform: action.platform, sourceConnected: true, sourceWorkspaceName: action.workspaceName };
    case 'DEST_CONNECTED':
      return { ...state, destConnected: true, destWorkspaceGid: action.workspaceGid, destWorkspaceName: action.workspaceName };
    case 'SET_TRACKING':
      return { ...state, trackingProjectGid: action.gid, trackingProjectName: action.name, trackingPortfolioGid: action.portfolioGid, trackingPortfolioName: action.portfolioName, trackingOwnerGid: action.ownerGid, trackingOwnerName: action.ownerName };
    case 'SET_USER_MAPPING':
      return { ...state, userMapping: action.mapping };
    case 'SET_PROJECT_SELECTION':
      return {
        ...state,
        selectedSourceProjectId: action.sourceId,
        selectedSourceProjectName: action.sourceName,
        selectedDestProjectGid: action.destGid,
        selectedDestProjectName: action.destName,
        selectedDestTeamGid: action.teamGid,
        selectedDestTeamName: action.teamName,
        isNewDestProject: action.isNew,
        projectOwnerGid: action.isNew ? action.ownerGid : null,
        projectOwnerName: action.isNew ? action.ownerName : null,
      };
    case 'SET_FIELD_MAPPING':
      return { ...state, fieldMapping: action.mapping, sectionMapping: action.sectionMapping, externalIdDestFieldGid: action.externalIdDestFieldGid };
    case 'MIGRATION_COMPLETE':
      return { ...state, lastReport: action.report, step: 'report' };
    case 'RELOAD_MAPPING':
      return { ...state, step: 'field-mapping', fieldMapping: [], sectionMapping: [], externalIdDestFieldGid: null };
    case 'RUN_ANOTHER':
      return {
        ...state,
        step: 'select-projects',
        selectedSourceProjectId: null,
        selectedSourceProjectName: null,
        selectedDestProjectGid: null,
        selectedDestProjectName: null,
        selectedDestTeamGid: null,
        selectedDestTeamName: null,
        isNewDestProject: false,
        projectOwnerGid: null,
        projectOwnerName: null,
        fieldMapping: [],
        sectionMapping: [],
        externalIdDestFieldGid: null,
        lastReport: null,
      };
    case 'SET_ANALYZE_PROJECTS':
      return { ...state, analyzeProjectIds: action.projects };
    case 'ANALYSIS_COMPLETE':
      return { ...state, analysisReport: action.report, step: 'analysis-report' };
    case 'RUN_ANOTHER_ANALYSIS':
      return { ...state, step: 'analyze-select', analyzeProjectIds: [], analysisReport: null };
    default:
      return state;
  }
}

const initialState: AppState = {
  authChecked: false,
  authenticated: false,
  user: null,
  appEnv: 'development',
  mode: 'migrate',
  step: 'connect',
  sourcePlatform: null,
  sourceConnected: false,
  sourceWorkspaceName: null,
  destConnected: false,
  destWorkspaceName: null,
  destWorkspaceGid: null,
  trackingProjectGid: null,
  trackingProjectName: null,
  trackingPortfolioGid: null,
  trackingPortfolioName: null,
  trackingOwnerGid: null,
  trackingOwnerName: null,
  userMapping: [],
  selectedSourceProjectId: null,
  selectedSourceProjectName: null,
  selectedDestProjectGid: null,
  selectedDestProjectName: null,
  selectedDestTeamGid: null,
  selectedDestTeamName: null,
  isNewDestProject: false,
  projectOwnerGid: null,
  projectOwnerName: null,
  fieldMapping: [],
  sectionMapping: [],
  externalIdDestFieldGid: null,
  analyzeProjectIds: [],
  lastReport: null,
  analysisReport: null,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  useEffect(() => {
    fetch('/auth/status')
      .then((r) => r.json())
      .then(async (data: { authenticated: boolean; user: AppState['user']; appEnv?: string }) => {
        dispatch({ type: 'AUTH_CHECKED', authenticated: data.authenticated, user: data.user ?? null, appEnv: data.appEnv ?? 'development' });
        if (data.authenticated) {
          try {
            const status = await fetch('/api/migrate/status').then((r) => r.json()) as { inProgress: boolean; report: MigrationReport | null; error: string | null };
            if (status.inProgress) {
              dispatch({ type: 'SET_STEP', step: 'running' });
            } else if (status.report) {
              dispatch({ type: 'MIGRATION_COMPLETE', report: status.report });
            }
          } catch {
            // Non-fatal — user starts at connect as normal.
          }
        }
      })
      .catch(() => dispatch({ type: 'AUTH_CHECKED', authenticated: false, user: null, appEnv: 'development' }));
  }, []);

  if (!state.authChecked) {
    return <div className="loading-screen"><div className="spinner" /></div>;
  }

  if (!state.authenticated) {
    return <Login />;
  }

  const next = (step: WizardStep) => dispatch({ type: 'SET_STEP', step });

  const STEPS = state.mode === 'analyze' ? ANALYZE_STEPS : MIGRATE_STEPS;
  const lockSteps: WizardStep[] = state.mode === 'analyze'
    ? ['analyzing', 'analysis-report']
    : ['running', 'report'];
  const navigableSteps = STEPS.filter((s) => !lockSteps.includes(s));
  const currentIndex = STEPS.indexOf(state.step);

  return (
    <div className="app-shell" data-mode={state.mode}>
      <header className="app-header">
        <div className="header-left">
          <img src="/logo" alt="Cirface" className="header-logo" />
          <h1>Migration Tool</h1>
        </div>
        <div className="header-right">
          {state.appEnv !== 'production' && (
            <a href="/dev-notes" target="_blank" rel="noreferrer" className="dev-notes-link">Dev Notes</a>
          )}
          <span className="user-name">{state.user?.name}</span>
          <a href="/auth/logout" className="btn btn-ghost">Logout</a>
        </div>
      </header>

      <div className="wizard-layout">
        <StepIndicator
          steps={navigableSteps.map((s) => ({ key: s, label: STEP_LABELS[s] }))}
          currentStep={state.step}
          completedUpTo={currentIndex}
        />

        <main className="wizard-content">
          {state.step === 'connect' && (
            <ConnectSources
              state={state}
              onModeChange={(mode) => dispatch({ type: 'SET_MODE', mode })}
              onSourceConnected={(platform, workspaceName) => {
                dispatch({ type: 'SOURCE_CONNECTED', platform, workspaceName });
              }}
              onDestConnected={(workspaceGid, workspaceName) => {
                dispatch({ type: 'DEST_CONNECTED', workspaceGid, workspaceName });
              }}
              onNext={() => next('tracking')}
            />
          )}
          {state.step === 'tracking' && (
            <TrackingProject
              destWorkspaceGid={state.destWorkspaceGid!}
              currentGid={state.trackingProjectGid}
              currentName={state.trackingProjectName}
              currentPortfolioGid={state.trackingPortfolioGid}
              currentPortfolioName={state.trackingPortfolioName}
              onSet={(gid, name, portfolioGid, portfolioName) => {
                dispatch({ type: 'SET_TRACKING', gid, name, portfolioGid, portfolioName, ownerGid: null, ownerName: null });
                next(state.mode === 'analyze' ? 'analyze-select' : 'user-mapping');
              }}
              onBack={() => next('connect')}
            />
          )}
          {/* ── Migrate-mode steps ── */}
          {state.step === 'user-mapping' && (
            <UserMapping
              state={state}
              onSave={(mapping) => {
                dispatch({ type: 'SET_USER_MAPPING', mapping });
                next('select-projects');
              }}
              onBack={() => next('tracking')}
            />
          )}
          {state.step === 'select-projects' && (
            <SelectProjects
              state={state}
              onSelect={(sourceId, sourceName, destGid, destName, teamGid, teamName, isNew, ownerGid, ownerName) => {
                dispatch({ type: 'SET_PROJECT_SELECTION', sourceId, sourceName, destGid, destName, teamGid, teamName, isNew, ownerGid, ownerName });
                next('field-mapping');
              }}
              onBack={() => next('user-mapping')}
            />
          )}
          {state.step === 'field-mapping' && (
            <FieldMapping
              state={state}
              onDraftChange={(mapping, sectionMapping, externalIdDestFieldGid) => {
                dispatch({ type: 'SET_FIELD_MAPPING', mapping, sectionMapping, externalIdDestFieldGid });
              }}
              onSave={(mapping, sectionMapping, externalIdDestFieldGid) => {
                dispatch({ type: 'SET_FIELD_MAPPING', mapping, sectionMapping, externalIdDestFieldGid });
                next('review');
              }}
              onBack={() => next('select-projects')}
            />
          )}
          {state.step === 'review' && (
            <ReviewConfirm
              state={state}
              onConfirm={() => next('running')}
              onBack={() => next('field-mapping')}
              onReloadMapping={() => {
                fetch('/api/session/reset-project', { method: 'POST' }).catch(() => {});
                dispatch({ type: 'RELOAD_MAPPING' });
              }}
            />
          )}
          {state.step === 'running' && (
            <RunMigration
              state={state}
              onComplete={(report) => dispatch({ type: 'MIGRATION_COMPLETE', report })}
              onBackToFieldMapping={() => {
                fetch('/api/session/reset-project', { method: 'POST' }).catch(() => {});
                dispatch({ type: 'RELOAD_MAPPING' });
              }}
            />
          )}
          {state.step === 'report' && (
            <Report
              report={state.lastReport!}
              onRunAnother={() => {
                fetch('/api/session/reset-project', { method: 'POST' }).catch(() => {});
                dispatch({ type: 'RUN_ANOTHER' });
              }}
            />
          )}
          {/* ── Analyze-mode steps ── */}
          {state.step === 'analyze-select' && (
            <AnalyzeSelectProjects
              state={state}
              onSelect={(projects) => {
                dispatch({ type: 'SET_ANALYZE_PROJECTS', projects });
                next('analyzing');
              }}
              onBack={() => next('tracking')}
            />
          )}
          {state.step === 'analyzing' && (
            <RunAnalysis
              state={state}
              onComplete={(report) => dispatch({ type: 'ANALYSIS_COMPLETE', report })}
            />
          )}
          {state.step === 'analysis-report' && (
            <AnalysisReport
              report={state.analysisReport!}
              onRunAnother={() => dispatch({ type: 'RUN_ANOTHER_ANALYSIS' })}
            />
          )}
        </main>
      </div>
    </div>
  );
}
