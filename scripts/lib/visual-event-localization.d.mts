export const VISUAL_EVENT_LOCALIZATION_ALGORITHM_VERSION: 3;
export const VISUAL_EXACT_TEXT_BINDING_VERSION: "visual-exact-text-binding-v2";

export type VisualSemanticVerification = {
  valid: boolean;
  reason: string;
  required_sides?: string[];
  sides?: Record<string, VisualSemanticVerification>;
  binding_sha256?: string;
  change_semantics_sha256?: string;
};

export function verifyVisualExactTextSemanticBinding(input?: {
  side?: unknown;
  changeDetails?: unknown;
  localization?: unknown;
  capture?: unknown;
}): VisualSemanticVerification;

export function verifyVisualEventSemanticBindings(input?: {
  changeDetails?: unknown;
  localization?: unknown;
  previousCapture?: unknown;
  currentCapture?: unknown;
}): VisualSemanticVerification;

export function visualChangeSemanticManifest(changeDetails?: unknown): {
  contract: string;
  change_semantics_sha256: string;
  sides: {
    previous: { candidates: unknown[]; candidates_sha256: string };
    current: { candidates: unknown[]; candidates_sha256: string };
  };
};

export function sha256VisualSemanticValue(value: unknown): string;
