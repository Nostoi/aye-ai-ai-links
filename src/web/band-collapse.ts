/**
 * The seems-gone band's slide-away (#298), a block of page script inside `CARD_FETCH`.
 * `collapseBand(band)` slides the band's card from its height with the band to its height without
 * it (measured with the band briefly hidden), fades the band, hides it, and answers once it is
 * hidden. It finishes at once under reduced motion or without `matchMedia`; otherwise it ends on
 * the card's height transition, or on a timer if none ends (a hidden parent never transitions).
 * `resetBand(band)` shows the band whole again: the card freed, any callback still
 * waiting dropped, so a late `transitionend` or timer never hides a band that came back.
 */
export const BAND_COLLAPSE = `const resetBand = (band) => {
  if (band._cancel) band._cancel();
  band.classList.remove("collapsing");
  band.hidden = false;
};
const collapseBand = (band) =>
  new Promise((resolve) => {
    if (band._cancel) band._cancel();
    const card = band.closest("[data-id]");
    if (!card || typeof matchMedia !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      band.hidden = true;
      resolve();
      return;
    }
    const start = card.offsetHeight;
    band.hidden = true;
    const end = card.offsetHeight;
    band.hidden = false;
    let timer = 0;
    const cancel = () => {
      clearTimeout(timer);
      card.removeEventListener("transitionend", onEnd);
      card.style.height = card.style.overflow = card.style.boxSizing = card.style.transition = "";
      band._cancel = null;
      resolve();
    };
    const finish = () => {
      band.hidden = true;
      cancel();
    };
    const onEnd = (event) => {
      if (event.target === card && event.propertyName === "height") finish();
    };
    band._cancel = cancel;
    card.addEventListener("transitionend", onEnd);
    timer = setTimeout(finish, 600);
    card.style.boxSizing = "border-box";
    card.style.height = start + "px";
    card.style.overflow = "hidden";
    card.style.transition = "height .3s ease";
    card.offsetHeight;
    band.classList.add("collapsing");
    card.style.height = end + "px";
  });`;
