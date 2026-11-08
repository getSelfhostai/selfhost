import { type Static, Type } from "@sinclair/typebox";
import { DateTime, NonEmpty, RepoSlug, StringEnum, schemaId, Url } from "./common.js";
import { createValidator, type ValidationResult } from "./validate.js";

export const RECEIPT_SCHEMA = "selfhost.receipt/v1";

/**
 * passed: everything that ran passed. failed: setup, the app, a test, a screen or the preview
 * failed. nothing_checked: no test, screen or preview to show for this change.
 */
export const RECEIPT_VERDICTS = ["passed", "failed", "nothing_checked"] as const;

/** The test runners a receipt picks for a changed test file; custom is `[receipt] test_command`. */
export const RECEIPT_RUNNERS = ["vitest", "jest", "node", "pytest", "go", "custom"] as const;

export const RECEIPT_APP_STATUSES = ["started", "failed", "not_configured"] as const;
export const RECEIPT_TEST_STATUSES = ["passed", "failed", "timed_out"] as const;
export const RECEIPT_SHOT_STATUSES = ["captured", "failed"] as const;
export const RECEIPT_PREVIEW_STATUSES = ["ready", "pending", "failed", "none"] as const;
export const RECEIPT_PREVIEW_SOURCES = ["deployment", "commit_status", "input"] as const;

export type ReceiptVerdict = (typeof RECEIPT_VERDICTS)[number];
export type ReceiptRunner = (typeof RECEIPT_RUNNERS)[number];
export type ReceiptAppStatus = (typeof RECEIPT_APP_STATUSES)[number];
export type ReceiptTestStatus = (typeof RECEIPT_TEST_STATUSES)[number];
export type ReceiptShotStatus = (typeof RECEIPT_SHOT_STATUSES)[number];
export type ReceiptPreviewStatus = (typeof RECEIPT_PREVIEW_STATUSES)[number];
export type ReceiptPreviewSource = (typeof RECEIPT_PREVIEW_SOURCES)[number];

const Sha = (description: string) => Type.String({ pattern: "^[0-9a-fA-F]{7,64}$", description });

const Milliseconds = (description: string) => Type.Integer({ minimum: 0, description });

export const ReceiptLogSchema = Type.Object(
  {
    tail: Type.String({
      description:
        "The last lines of the output, secrets and emails masked. The whole log is in the artifact.",
    }),
    lines: Type.Integer({ minimum: 0, description: "Lines in the whole output." }),
    file: Type.Optional(NonEmpty({ description: "The whole log's path inside the artifact." })),
  },
  { additionalProperties: false, description: "Output of a command." },
);

export const ReceiptStepSchema = Type.Object(
  {
    command: NonEmpty({ description: "The shell command, as configured." }),
    status: StringEnum(["passed", "failed"] as const, { description: "Its exit status." }),
    exit_code: Type.Optional(Type.Integer({ description: "Exit code; absent when killed." })),
    duration_ms: Milliseconds("How long it ran."),
    log: Type.Optional(ReceiptLogSchema),
  },
  { additionalProperties: false, description: "The setup script, from [runtime] setup." },
);

export const ReceiptAppSchema = Type.Object(
  {
    status: StringEnum(RECEIPT_APP_STATUSES, {
      description:
        "started: it answered at url. failed: it exited or did not answer in time. not_configured: no start command.",
    }),
    command: Type.Optional(NonEmpty({ description: "The start command." })),
    url: Type.Optional(Url({ description: "The ready URL it was waited on at." })),
    duration_ms: Type.Optional(Milliseconds("From start until it answered, or gave up.")),
    exit_code: Type.Optional(Type.Integer({ description: "Exit code when it exited early." })),
    error: Type.Optional(NonEmpty({ description: "Why it did not start, in one sentence." })),
    log: Type.Optional(ReceiptLogSchema),
  },
  { additionalProperties: false, description: "Starting the app for the screenshots." },
);

export const ReceiptTestRunSchema = Type.Object(
  {
    files: Type.Array(NonEmpty(), {
      minItems: 1,
      description: "Test files run, relative to the repository root.",
    }),
    runner: StringEnum(RECEIPT_RUNNERS, { description: "The runner that ran them." }),
    command: NonEmpty({ description: "The command, as run in cwd." }),
    cwd: Type.String({ description: "Folder it ran in, relative to the repository root." }),
    status: StringEnum(RECEIPT_TEST_STATUSES, { description: "The result." }),
    exit_code: Type.Optional(Type.Integer({ description: "Exit code; absent when killed." })),
    duration_ms: Milliseconds("How long it ran."),
    log: Type.Optional(ReceiptLogSchema),
  },
  { additionalProperties: false, description: "One run of the tests the change adds or edits." },
);

export const ReceiptTestsSchema = Type.Object(
  {
    runs: Type.Array(ReceiptTestRunSchema, { description: "Each run, in order." }),
    not_run: Type.Array(
      Type.Object(
        {
          path: NonEmpty({ description: "Test file, relative to the repository root." }),
          reason: NonEmpty({ description: "Why it was not run." }),
        },
        { additionalProperties: false },
      ),
      { description: "Changed test files that were not run, with why." },
    ),
  },
  {
    additionalProperties: false,
    description: "The tests the pull request adds or changes, run with the repository's runner.",
  },
);

export const ReceiptShotSchema = Type.Object(
  {
    path: NonEmpty({ description: "URL path of the screen, from [receipt.screens]." }),
    url: Url({ description: "The URL that was opened." }),
    files: Type.Array(NonEmpty(), {
      description: "Changed files mapped to this screen. Empty for the default home page shot.",
    }),
    status: StringEnum(RECEIPT_SHOT_STATUSES, {
      description: "captured, or failed with an error or an HTTP status of 400 or more.",
    }),
    http_status: Type.Optional(Type.Integer({ description: "Status of the page's response." })),
    image: Type.Optional(NonEmpty({ description: "The PNG's path inside the artifact." })),
    page_errors: Type.Optional(
      Type.Array(Type.String(), { description: "Uncaught errors the page threw, at most 5." }),
    ),
    error: Type.Optional(NonEmpty({ description: "Why it could not be captured." })),
  },
  { additionalProperties: false, description: "A screenshot of one screen." },
);

export const ReceiptScreensSchema = Type.Object(
  {
    base_url: Type.Optional(Url({ description: "Where the screens were opened." })),
    source: StringEnum(["app", "preview", "none"] as const, {
      description: "app: the app started for the receipt. preview: the preview environment.",
    }),
    shots: Type.Array(ReceiptShotSchema, { description: "One per screen." }),
  },
  { additionalProperties: false, description: "Playwright screenshots of the changed screens." },
);

export const ReceiptPreviewSchema = Type.Object(
  {
    status: StringEnum(RECEIPT_PREVIEW_STATUSES, {
      description:
        "ready: url serves the change. pending: it was still deploying when the receipt gave up waiting. failed: the deployment failed. none: no preview environment.",
    }),
    url: Type.Optional(Url({ description: "The preview link." })),
    name: Type.Optional(NonEmpty({ description: "Environment or status name, such as Preview." })),
    source: Type.Optional(
      StringEnum(RECEIPT_PREVIEW_SOURCES, { description: "Where it came from." }),
    ),
    provider: Type.Optional(NonEmpty({ description: "vercel, netlify, or another host's name." })),
  },
  { additionalProperties: false, description: "The pull request's preview environment." },
);

export const ReceiptSchema = Type.Object(
  {
    schema: Type.Literal(RECEIPT_SCHEMA),
    repo: RepoSlug({ description: "owner/name on GitHub." }),
    pull: Type.Object(
      {
        number: Type.Integer({ minimum: 1, description: "Pull request number." }),
        url: Url({ description: "The pull request on GitHub." }),
        head_sha: Sha("The head commit the receipt checked."),
        base_sha: Type.Optional(Sha("The base commit.")),
      },
      { additionalProperties: false, description: "The pull request the receipt is for." },
    ),
    created_at: DateTime({ description: "When the receipt was made." }),
    verdict: StringEnum(RECEIPT_VERDICTS, { description: "The receipt's result in one word." }),
    ci: Type.Optional(
      Type.Object(
        {
          run_url: Url({ description: "The CI run that made the receipt." }),
          run_id: NonEmpty({ description: "Its id." }),
          attempt: Type.Optional(Type.Integer({ minimum: 1, description: "Its attempt." })),
          workflow: Type.Optional(NonEmpty({ description: "Workflow name." })),
        },
        { additionalProperties: false, description: "Where the receipt was made." },
      ),
    ),
    artifact: Type.Optional(
      Type.Object(
        {
          name: NonEmpty({ description: "Name of the uploaded artifact." }),
          url: Type.Optional(Url({ description: "Download link for the artifact." })),
        },
        {
          additionalProperties: false,
          description: "The workflow artifact with the screenshots, logs and receipt.html.",
        },
      ),
    ),
    setup: Type.Optional(ReceiptStepSchema),
    app: ReceiptAppSchema,
    tests: ReceiptTestsSchema,
    screens: ReceiptScreensSchema,
    preview: ReceiptPreviewSchema,
    notes: Type.Array(Type.String(), {
      description: "What the receipt could not check, and why, one sentence each.",
    }),
  },
  {
    $id: schemaId("receipt.schema.json"),
    title: "Receipt",
    description:
      "Proof receipt of an agent pull request: the tests it adds or changes and their results, screenshots of the screens it touches, its preview link, and the logs of anything that failed.",
    additionalProperties: false,
  },
);

export type Receipt = Static<typeof ReceiptSchema>;
export type ReceiptLog = Static<typeof ReceiptLogSchema>;
export type ReceiptStep = Static<typeof ReceiptStepSchema>;
export type ReceiptApp = Static<typeof ReceiptAppSchema>;
export type ReceiptTestRun = Static<typeof ReceiptTestRunSchema>;
export type ReceiptTests = Static<typeof ReceiptTestsSchema>;
export type ReceiptShot = Static<typeof ReceiptShotSchema>;
export type ReceiptScreens = Static<typeof ReceiptScreensSchema>;
export type ReceiptPreview = Static<typeof ReceiptPreviewSchema>;

export const receiptValidator = createValidator(ReceiptSchema);

export function validateReceipt(value: unknown): ValidationResult<Receipt> {
  return receiptValidator.validate(value);
}
