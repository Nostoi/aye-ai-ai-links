import { TIDY_SESSION } from "../core/tidy-up.js";
import { type TidyTrayInput, tidyStep } from "./tidy-step.js";
import { spine } from "./tray-spine.js";

export type { TidyTrayInput } from "./tidy-step.js";

/** What the closed tray says: Home's quiet offer, with Start. */
const CLOSED = `<div class="tidy-closed">
<div>
<p>Clear out a few old links?</p>
<p class="small">Five, one at a time. Nothing gets deleted.</p>
</div>
<button type="button" data-tidy="start">Start</button>
</div>`;

function finish(count: number): string {
  const heading = count === TIDY_SESSION ? `That's five. Done for now.` : "Done for now.";
  return `<div class="tidy-done" hidden>
<h3>${heading}</h3>
<p>Everything you archive is still saved and still searchable.</p>
<p><button type="button" data-tidy="close">Close</button></p>
</div>`;
}

/**
 * Home's Tidy up tray (#332): a slim tray with the Tidy spine. It is drawn closed, with every step
 * and the finish screen hidden; `TIDY_SCRIPT` opens a session in place. Home draws it only when
 * core's `tidySession` gives a queue.
 */
export const tidyTray = (
  input: TidyTrayInput,
): string => `<section class="tidy-tray" id="tidy" aria-labelledby="tidy-title">
${spine("tidy")}
<h2 id="tidy-title" class="visually-hidden">Tidy up</h2>
<p id="tidy-error" role="alert"></p>
${CLOSED}
${input.queue.map((t, i) => tidyStep(t, i, input)).join("\n")}
${finish(input.queue.length)}
</section>
`;
