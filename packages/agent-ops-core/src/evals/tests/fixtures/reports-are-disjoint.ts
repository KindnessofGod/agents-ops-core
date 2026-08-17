/**
 * Fixture: agreement is not accuracy, and the compiler is what enforces it.
 *
 * Every `@ts-expect-error` below is an assertion that the line does not compile.
 * If any of them starts compiling, `TS2578` fires and the test fails — so the
 * guarantee cannot rot quietly.
 */
import { gate } from "../../index.js";
import type {
  AccuracyReport,
  AgreementReport,
  Baseline,
  EvalRecorder,
  GateFloors,
} from "../../index.js";

declare const accuracy: AccuracyReport;
declare const agreement: AgreementReport;
declare const baseline: Baseline;
declare const floors: GateFloors;
declare const recorder: EvalRecorder;

// @ts-expect-error an agreement report is not an accuracy report
const laundered: AccuracyReport = agreement;

// @ts-expect-error and it does not work in the other direction either
const reversed: AgreementReport = accuracy;

// @ts-expect-error you cannot build a continuous-integration gate on agreement data
void gate({ report: agreement, baseline, floors, recorder });

// The legitimate call compiles.
void gate({ report: accuracy, baseline, floors, recorder });

// @ts-expect-error there is no `correct` on an agreement report; the name is absent on purpose
void agreement.correctBasisPoints;

// @ts-expect-error and no `agreement` on an accuracy report
void accuracy.agreementBasisPoints;

void laundered;
void reversed;
