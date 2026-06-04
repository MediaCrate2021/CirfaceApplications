//-------------------------//
// src/App.tsx
// Code implemented by Cirface.com / MMG
//
// Root wizard for the Cirface Migration Estimator.
// Steps: connect → select-projects → analyzing → report
//
// Disclaimer: This code was created with the help of Claude.AI
//-------------------------//

import { useEffect, useReducer } from 'react';
import StepIndicator from '@cirface/core/components/shared/StepIndicator';
import ConnectSource from './components/steps/ConnectSource.tsx';
import SelectProjects from './components/steps/SelectProjects.tsx';
import RunAnalysis from './components/steps/RunAnalysis.tsx';
import AnalysisReport from './components/steps/AnalysisReport.tsx';
import type { AnalysisReport as AnalysisReportType, SourcePlatform } from '@cirface/core/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WizardStep = 'connect' | 'select-projects' | 'analyzing' | 'report';

export interface AppState {
  step: WizardStep;
  appEnv: 'development' | 'staging' | 'production';
  platform: SourcePlatform | null;
  selectedProjects: Array<{ id: string; name: string }>;
  report: AnalysisReportType | null;
}

type Action =
  | { type: 'SET_ENV'; env: AppState['appEnv'] }
  | { type: 'SOURCE_CONNECTED'; platform: SourcePlatform }
  | { type: 'PROJECTS_SELECTED'; projects: Array<{ id: string; name: string }> }
  | { type: 'ANALYSIS_COMPLETE'; report: AnalysisReportType }
  | { type: 'RESET' };

const initialState: AppState = {
  step: 'connect',
  appEnv: 'development',
  platform: null,
  selectedProjects: [],
  report: null,
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_ENV':
      return { ...state, appEnv: action.env };
    case 'SOURCE_CONNECTED':
      return { ...state, step: 'select-projects', platform: action.platform, selectedProjects: [] };
    case 'PROJECTS_SELECTED':
      return { ...state, step: 'analyzing', selectedProjects: action.projects };
    case 'ANALYSIS_COMPLETE':
      return { ...state, step: 'report', report: action.report };
    case 'RESET':
      return { ...initialState, appEnv: state.appEnv };
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Step config
// ---------------------------------------------------------------------------

const STEP_LABELS: Record<WizardStep, string> = {
  'connect':         'Connect',
  'select-projects': 'Select Projects',
  'analyzing':       'Analyzing',
  'report':          'Report',
};

// Steps visible in the sidebar (locked steps are shown but not navigable)
const LOCK_STEPS: WizardStep[] = ['analyzing'];
const ALL_STEPS: WizardStep[]  = ['connect', 'select-projects', 'analyzing', 'report'];
const SIDEBAR_STEPS = ALL_STEPS.filter((s) => !LOCK_STEPS.includes(s));

// ---------------------------------------------------------------------------
// Environment badge
// ---------------------------------------------------------------------------

const ENV_BADGE: Record<AppState['appEnv'], { label: string; style: React.CSSProperties } | null> = {
  development: {
    label: 'DEV',
    style: { background: '#16b4bf', color: '#fff', padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.05em' },
  },
  staging: {
    label: 'STAGING',
    style: { background: '#ffa100', color: '#1a1a1a', padding: '2px 8px', borderRadius: 4, fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.05em' },
  },
  production: null,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Fetch environment from server once on mount
  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then((data: { env?: string }) => {
        const env = data.env as AppState['appEnv'];
        if (env === 'staging' || env === 'production' || env === 'development') {
          dispatch({ type: 'SET_ENV', env });
        }
      })
      .catch(() => { /* keep default */ });
  }, []);

  function handleReset() {
    fetch('/api/source/disconnect', { method: 'POST' }).catch(() => {});
    dispatch({ type: 'RESET' });
  }

  const sidebarIndex  = SIDEBAR_STEPS.indexOf(state.step);
  // Count how many sidebar steps are completed
  const completedUpTo = sidebarIndex >= 0 ? sidebarIndex : SIDEBAR_STEPS.length;

  const badge = ENV_BADGE[state.appEnv];

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-left">
          <img src="/logo" alt="Cirface" className="header-logo" />
          <h1>Migration Estimator</h1>
          {badge && <span style={badge.style}>{badge.label}</span>}
        </div>
        <div className="header-right">
          {state.step !== 'connect' && (
            <button className="btn btn-ghost" onClick={handleReset}>
              Start Over
            </button>
          )}
        </div>
      </header>

      <div className="wizard-layout">
        <StepIndicator
          steps={SIDEBAR_STEPS.map((s) => ({ key: s, label: STEP_LABELS[s] }))}
          currentStep={state.step === 'analyzing' ? 'select-projects' : state.step}
          completedUpTo={completedUpTo}
        />

        <main className="wizard-content">
          {state.step === 'connect' && (
            <ConnectSource
              onConnected={(platform) => dispatch({ type: 'SOURCE_CONNECTED', platform })}
            />
          )}

          {state.step === 'select-projects' && state.platform && (
            <SelectProjects
              platform={state.platform}
              onSelect={(projects) => dispatch({ type: 'PROJECTS_SELECTED', projects })}
              onBack={handleReset}
            />
          )}

          {state.step === 'analyzing' && (
            <RunAnalysis
              projectIds={state.selectedProjects.map((p) => p.id)}
              projectCount={state.selectedProjects.length}
              onComplete={(report) => dispatch({ type: 'ANALYSIS_COMPLETE', report })}
            />
          )}

          {state.step === 'report' && state.report && (
            <AnalysisReport
              report={state.report}
              onRunAnother={handleReset}
            />
          )}
        </main>
      </div>
    </div>
  );
}
