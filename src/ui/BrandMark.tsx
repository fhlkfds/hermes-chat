/** The app icon's eagle on the rail's tile: the head in the tile's text colour, the beak and eye a pale tint of the accent (ADR 0176). */
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="48 40 416 416" aria-hidden="true">
      <path d="M104 480L104 404L118 356L90 364L118 316L92 318L132 274L110 270C146 198 208 142 286 134C342 128 386 150 404 190C424 198 438 220 438 246C438 274 426 296 410 306C410 288 402 276 390 272C382 284 366 290 348 288C316 314 286 360 280 480Z" fill="currentColor" />
      <path className="brand-light" d="M390 186C416 192 438 216 438 246C438 274 426 296 410 306C410 288 402 276 390 272C378 270 364 274 354 280L346 254C366 246 382 234 390 186Z" />
      <path className="brand-brow" d="M286 198C312 180 344 180 370 194C348 196 326 206 310 220Z" />
      <circle className="brand-light" cx="336" cy="216" r="15" />
    </svg>
  );
}
