// A counter that rolls to its new value.
//
// Never put this around a casualty figure. Fatality and injury counts on this
// map render directly and snap, and they do so on purpose: a death toll
// climbing like an odometer is the one thing here that must not be performed.
// If a future ticker counts people, it does not get this component.

import { useCountUp } from "../hooks/useCountUp";

export default function CountUp({ value }) {
  const shown = useCountUp(Number.isFinite(value) ? value : 0);
  return <>{shown}</>;
}
