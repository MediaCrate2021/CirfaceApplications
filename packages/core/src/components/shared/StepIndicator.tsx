//-------------------------//
// packages/core/src/components/shared/StepIndicator.tsx
// Code implemented by Cirface.com / MMG
//
// Generic vertical step indicator sidebar used by migration-tool and estimator.
// Uses string keys so each app can supply its own step union type.
//-------------------------//

interface Step {
  key: string;
  label: string;
}

interface Props {
  steps: Step[];
  currentStep: string;
  completedUpTo: number;
}

export default function StepIndicator({ steps, currentStep, completedUpTo }: Props) {
  return (
    <nav className="step-indicator" aria-label="Steps">
      {steps.map((step, index) => {
        const isCompleted = index < completedUpTo;
        const isCurrent   = step.key === currentStep;
        return (
          <div
            key={step.key}
            className={[
              'step-indicator-item',
              isCompleted ? 'completed' : '',
              isCurrent   ? 'current'   : '',
            ].filter(Boolean).join(' ')}
          >
            <div className="step-indicator-dot">
              {isCompleted ? '✓' : <span>{index + 1}</span>}
            </div>
            <span className="step-indicator-label">{step.label}</span>
            {index < steps.length - 1 && <div className="step-indicator-line" />}
          </div>
        );
      })}
    </nav>
  );
}
