import { type TidyTrayInput, tidyStep } from "./tidy-step.js";
import { spine } from "./tray-spine.js";

export type { TidyTrayInput } from "./tidy-step.js";

/** What the closed tray says: Home's quiet offer, with Start. */
const CLOSED = `<div class="tidy-closed">
<div>
<p>Clear out a few links?</p>
<p class="small">One at a time. Nothing gets deleted.</p>
</div>
<button type="button" data-tidy="start">Start</button>
</div>`;

const FINISH = `<div class="tidy-done" hidden>
<h3>Done for now.</h3>
<p>Everything you archive is still saved and still searchable.</p>
<p><button type="button" data-tidy="close">Close</button></p>
</div>`;

const closed = (count: number) =>
  CLOSED.replace(
    "One at a time.",
    `${count} ${count === 1 ? "link" : "links"} to look at. One at a time.`,
  );

const frame = (body: string) => `<section class="tidy-tray" id="tidy" aria-labelledby="tidy-title">
${spine("tidy")}
<h2 id="tidy-title" class="visually-hidden">Tidy up</h2>
${body}
</section>
`;

/** The tray when core's `tidySession` has nothing to ask: no Start, and no script to bind. */
const EMPTY = frame(`<p class="tidy-quiet">Nothing to tidy right now.</p>
<p class="small tidy-quiet-more">Links you haven&rsquo;t opened in 30 days, and pages that seem gone, show up here.</p>`);

/**
 * Home's Tidy up tray (#332): a slim tray with the Tidy spine, always the last tray. With a queue
 * from core's `tidySession` (up to five links) it is drawn closed, saying how many wait, with every
 * step and the finish screen hidden; `TIDY_SCRIPT` opens a session in place. Without one it says
 * there is nothing to tidy.
 */
export const tidyTray = (input: TidyTrayInput | undefined): string =>
  input === undefined || input.queue.length === 0
    ? EMPTY
    : frame(`<p id="tidy-error" role="alert"></p>
${closed(input.queue.length)}
${input.queue.map((t, i) => tidyStep(t, i, input)).join("\n")}
${FINISH}`);
