/** The "link eyes" mark. Its colors are literal so it also works as a standalone favicon file. */
export const logoSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 36"><rect x="3.5" y="5.5" width="33" height="25" rx="12.5" fill="#fff" stroke="#2F8F83" stroke-width="5"/><rect x="27.5" y="5.5" width="33" height="25" rx="12.5" fill="#fff" stroke="#2F8F83" stroke-width="5"/><circle cx="19" cy="15.5" r="5" fill="#26262B"/><circle cx="47" cy="15.5" r="5" fill="#26262B"/></svg>';

/** The mark inline in a page, with extra attributes on the `<svg>` element. */
export const inlineLogo = (attributes: string) => logoSvg.replace("<svg ", `<svg ${attributes} `);

/** The value for `<link rel="icon" href="...">`. */
export const faviconHref = `data:image/svg+xml,${encodeURIComponent(logoSvg)}`;
