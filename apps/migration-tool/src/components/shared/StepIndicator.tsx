import type { WizardStep } from '../../App.tsx';

interface Step {
  key: WizardStep;
  label: string;
}

interface Props {
  steps: Step[];
  currentStep: WizardStep;
  completedUpTo: number;
}

export default function StepIndicator({ steps, currentStep, completedUpTo }: Props) {
  return (
    <nav className="step-indicator" aria-label="Migration steps">
      {steps.map((step, index) => {
        const isCompleted = index < completedUpTo;
        const isCurrent = step.key === currentStep;
        return (
          <div
            key={step.key}
            className={[
              'step-indicator-item',
              isCompleted ? 'completed' : '',
              isCurrent ? 'current' : '',
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
