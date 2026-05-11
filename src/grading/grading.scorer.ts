/**
 * Pure grading scorer function — no side effects, fully unit-testable.
 * Implements the worst-of-parameters algorithm from the spec PDF.
 */

export type Thresholds = Record<string, number>;
export type GradingParameterInput = {
  name: string;
  unit: string;
  isDefective: boolean;
  thresholds: Thresholds;
};

export type ScoreInput = {
  parameters: GradingParameterInput[];
  measurements: Record<string, number>;
  numberOfGrades: number;
};

export type PerParameterResult = {
  name: string;
  value: number;
  grade: string;
  withinThreshold: boolean;
};

export type ScoreResult = {
  computedGrade: string;
  totalDefectivePct: number;
  standardDeductionPct: number;
  perParameter: PerParameterResult[];
  failingParameters?: string[];
};

/**
 * Grade labels: Grade 1 = best, Grade N = worst. REJECTED if any exceeds all thresholds.
 */
export function scoreSample(input: ScoreInput): ScoreResult {
  const { parameters, measurements, numberOfGrades } = input;
  const gradeLabels = Array.from({ length: numberOfGrades }, (_, i) => `Grade ${i + 1}`);

  // Validate all required measurements are present
  const missing = parameters
    .map((p) => p.name)
    .filter((name) => !(name in measurements));
  if (missing.length > 0) {
    throw new Error(`Missing measurements for: ${missing.join(', ')}`);
  }

  // Validate no extra measurements
  const paramNames = new Set(parameters.map((p) => p.name));
  const extra = Object.keys(measurements).filter((m) => !paramNames.has(m));
  if (extra.length > 0) {
    throw new Error(`Unknown measurement parameters: ${extra.join(', ')}`);
  }

  const perParameter: PerParameterResult[] = [];
  const failingParameters: string[] = [];
  let worstGradeIndex = 0; // 0 = Grade 1 (best)

  for (const param of parameters) {
    const value = measurements[param.name];
    let assignedGradeIndex = -1; // -1 = REJECTED

    for (let i = 0; i < gradeLabels.length; i++) {
      const label = gradeLabels[i];
      const threshold = param.thresholds[label];
      if (threshold !== undefined && value <= threshold) {
        assignedGradeIndex = i;
        break;
      }
    }

    const withinThreshold = assignedGradeIndex !== -1;

    if (!withinThreshold) {
      failingParameters.push(param.name);
    } else if (assignedGradeIndex > worstGradeIndex) {
      worstGradeIndex = assignedGradeIndex;
    }

    perParameter.push({
      name: param.name,
      value,
      grade: withinThreshold ? gradeLabels[assignedGradeIndex] : 'REJECTED',
      withinThreshold,
    });
  }

  if (failingParameters.length > 0) {
    return {
      computedGrade: 'REJECTED',
      totalDefectivePct: 0,
      standardDeductionPct: 0,
      perParameter,
      failingParameters,
    };
  }

  const computedGrade = gradeLabels[worstGradeIndex];

  // Calculate totals for defective parameters
  const totalDefectivePct = parameters
    .filter((p) => p.isDefective)
    .reduce((sum, p) => sum + measurements[p.name], 0);

  // Standard deduction from "Standard Deduction" parameter if present
  const stdDeductionParam = parameters.find((p) => p.name === 'Standard Deduction');
  const standardDeductionPct = stdDeductionParam
    ? stdDeductionParam.thresholds[computedGrade] ?? 0
    : 0;

  return { computedGrade, totalDefectivePct, standardDeductionPct, perParameter };
}
