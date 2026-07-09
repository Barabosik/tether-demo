/* The canonical world names — ONE place. The select header, the Best Times
 * modal and the LINE results all read from here; a world without a row shows
 * plain "WORLD n" (customs, not-yet-shipped ids). W3+ add their row when
 * they ship. */
export const WORLD_NAME = {
  1: "THE SUNKEN SHALLOWS",
  2: "THE MINES",
  3: "THE INFERNO",
};

export const worldName = (w) => WORLD_NAME[w] || `WORLD ${w}`;
