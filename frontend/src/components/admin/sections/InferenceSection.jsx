// Task 31: the important section. Every inferred product this plan built --
// laden/ballast draught, cargo class, dark-ship gaps/transfers/
// reachability, port calls, AIS traffic density, flight legs -- gets a
// three-state switch here (hide/labelled/show, see
// settings/inferenceProducts.js) and, below it, the real thresholds that
// turned raw AIS/ADS-B history into that inference: draught percentages,
// gap hours, dwell speed, port radii, the lane-density decay factor and so
// on (backend/inference_config.py's own describe()).
//
// Those thresholds are read-only, on purpose -- see this section's own note
// above the fields, and inference_config.py's module docstring for the full
// reasoning. The short version: they are constants inside the refine
// process, a separate long-running service with no channel for Admin
// Mode's frontend-only settings PUT to reach, and a dial that cannot move
// anything is worse than no dial.
import { useEffect, useState } from "react";
import { PanelGroup } from "../../controlPanel/Collapsible";
import { fetchJson } from "../../../api";
import { INFERENCE_PRODUCTS, INFERENCE_STATES } from "../../../settings/inferenceProducts";

export const SEARCH_TERMS = [
  "Inference",
  "Hide",
  "Labelled",
  "Show",
  ...INFERENCE_PRODUCTS.map((p) => p.label),
];

const STATE_LABEL = { hide: "Hide", labelled: "Show labelled", show: "Show" };

function useInferenceThresholds() {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchJson("/api/inference-config")
      .then((body) => {
        if (!cancelled) setDoc(body);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return { doc, error };
}

export default function InferenceSection({ settings, actions, isOpen, onToggle }) {
  const { doc, error } = useInferenceThresholds();

  return (
    <PanelGroup id="adm-inference" title="Inference" open={isOpen("adm-inference")} onToggle={onToggle}>
      <div className="admin-note">
        <b>Hide</b> draws nothing for this product. <b>Show labelled</b>, the default, is what this
        map already does whenever the scene resolver decides to draw it -- every inferred layer and
        card section here carries its own honesty caveat unconditionally, so there is no state that
        removes it (see this project's own rule: an inference is never presented as an observation).
        For a product backed by a real map layer, <b>Show</b> pins that layer on regardless of the
        resolver -- the same pinned-on state a control-drawer tick would set, reached here instead.
        For a product with no layer of its own (marked <b>Show = Show labelled</b> below), Show and
        Show labelled render identically; only Hide changes anything for those.
      </div>

      {INFERENCE_PRODUCTS.map((product) => (
        <InferenceProductBlock
          key={product.key}
          product={product}
          mode={settings.inference.mode[product.key]}
          onModeChange={(value) => actions.setInferenceProductMode(product, value)}
          fields={doc ? fieldsFor(doc, product) : null}
          error={error}
        />
      ))}
    </PanelGroup>
  );
}

function fieldsFor(doc, product) {
  return product.backendKeys.flatMap((key) => doc[key]?.fields || []);
}

function InferenceProductBlock({ product, mode, onModeChange, fields, error }) {
  const showIsNoOp = product.effect === "card";
  return (
    <details className="admin-layer-block">
      <summary className="admin-layer-summary">
        <span className="admin-layer-name">{product.label}</span>
        {/* Task 31 review, Minor 2: a visible cue on the row itself, not
            just a paragraph a reader has to open the block to find --
            "Show" is a silent no-op for a card-effect product (see
            showIsNoOp below), and the Critical this task also fixed was
            exactly this class of problem: a control that moves nothing
            with no cue on the control that it won't. */}
        {showIsNoOp && <span className="admin-layer-badge">Show = Show labelled</span>}
      </summary>
      <div className="admin-layer-body">
        <div className="admin-tri-state" role="radiogroup" aria-label={`${product.label} visibility`}>
          {INFERENCE_STATES.map((state) => (
            <button
              key={state}
              type="button"
              role="radio"
              aria-checked={mode === state}
              className={`admin-tri-state-btn${mode === state ? " selected" : ""}`}
              title={
                showIsNoOp && state === "show"
                  ? "No layer of its own to pin on -- renders exactly like Show labelled."
                  : undefined
              }
              onClick={() => onModeChange(state)}
            >
              {STATE_LABEL[state]}
            </button>
          ))}
        </div>
        {product.effect === "layer" ? (
          <div className="admin-note">
            Backed by the <b>{product.layerKey}</b> layer -- Hide/Show here write the same
            pinned-off/pinned-on state the control drawer's own checkbox would.
          </div>
        ) : (
          <div className="admin-note">
            No map layer of its own -- Hide removes this card section entirely; <b>Show behaves
            exactly like Show labelled</b> (its honesty caveat is unconditional either way, see this
            section's own note above), so only Hide actually changes anything for this product.
          </div>
        )}

        <div className="admin-subhead">Thresholds (read-only)</div>
        <div className="admin-note">
          Constants inside the refine service, a separate long-running process this settings panel
          has no channel to reach live -- see this section's own module note. Shown here so a reader
          can see exactly what turned raw AIS/ADS-B history into this inference, without a dial that
          would silently do nothing if moved.
        </div>
        {error && <div className="admin-note">Could not load thresholds: {error}</div>}
        {!error && !fields && <div className="admin-note">Loading&hellip;</div>}
        {fields && fields.length === 0 && (
          <div className="admin-note">No numeric threshold -- this product is a lookup table, not a percentage or a radius.</div>
        )}
        {fields && fields.length > 0 && (
          <table className="admin-threshold-table">
            <tbody>
              {fields.map((field) => (
                <tr key={field.key} title={field.note}>
                  <td>{field.label}</td>
                  <td>
                    {field.value}
                    {field.unit ? ` ${field.unit}` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </details>
  );
}
