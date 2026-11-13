/**
 * The seems-gone band's slide-away (#298), a block of page script inside `CARD_FETCH`.
 * `collapseBand(band)` shrinks the band to nothing, hides it, and answers once it is hidden. It
 * finishes at once under reduced motion or without `matchMedia`; otherwise it ends on the band's
 * own height transition, or on a timer if none ends (a hidden parent never transitions).
 * `resetBand(band)` shows the band whole again: collapse styles cleared, any callback still
 * waiting dropped, so a late `transitionend` or timer never hides a band that came back.
 */
export const BAND_COLLAPSE = `const resetBand = (band) => {
  if (band._cancel) band._cancel();
  band.classList.remove("collapsing");
  band.style.height = "";
  band.hidden = false;
};
const collapseBand = (band) =>
  new Promise((resolve) => {
    if (band._cancel) band._cancel();
    const start = band.offsetHeight || 0;
    if (typeof matchMedia !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      band.hidden = true;
      resolve();
      return;
    }
    let timer = 0;
    const cancel = () => {
      clearTimeout(timer);
      band.removeEventListener("transitionend", onEnd);
      band._cancel = null;
      resolve();
    };
    const finish = () => {
      band.hidden = true;
      cancel();
    };
    const onEnd = (event) => {
      if (event.target === band && event.propertyName === "height") finish();
    };
    band._cancel = cancel;
    band.addEventListener("transitionend", onEnd);
    timer = setTimeout(finish, 600);
    band.style.height = start + "px";
    band.offsetHeight;
    band.classList.add("collapsing");
    band.style.height = "0px";
  });`;
