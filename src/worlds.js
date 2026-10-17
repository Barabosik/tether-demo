/* The canonical world names — ONE place. The select header, the Best Times
 * modal and the LINE results all read from here; a world without a row shows
 * plain "World n" (customs, not-yet-shipped ids). W3+ add their row when
 * they ship. */
export const WORLD_NAME = {
  1: "The Sunken Shallows",
  2: "The Mines",
  3: "The Inferno",
};

export const worldName = (w) => WORLD_NAME[w] || `World ${w}`;
