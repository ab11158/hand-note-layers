import { setIcon, setTooltip } from "obsidian";

export function createIconButton(icon: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "clickable-icon hand-note-tool";
  button.setAttribute("aria-label", label);
  setIcon(button, icon);
  setTooltip(button, label);
  return button;
}

export function createToolbar(): HTMLDivElement {
  const toolbar = document.createElement("div");
  toolbar.className = "hand-note-toolbar";
  return toolbar;
}

export interface LabeledSliderControl {
  element: HTMLElement;
  input: HTMLInputElement;
  setDisabled: (disabled: boolean) => void;
  setLabel: (label: string) => void;
  setRange: (min: number, max: number, step: number) => void;
  setValue: (value: number) => void;
}

export function createLabeledSlider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onChange: (value: number) => void
): LabeledSliderControl {
  const wrapper = document.createElement("label");
  wrapper.className = "hand-note-slider";

  const text = document.createElement("span");
  text.textContent = label;

  const valueText = document.createElement("output");
  valueText.className = "hand-note-slider-value";
  valueText.textContent = String(value);

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => {
    valueText.textContent = input.value;
    onChange(Number(input.value));
  });

  wrapper.append(text, input, valueText);
  return {
    element: wrapper,
    input,
    setDisabled: (disabled) => {
      input.disabled = disabled;
      wrapper.classList.toggle("is-disabled", disabled);
    },
    setLabel: (label) => {
      text.textContent = label;
    },
    setRange: (nextMin, nextMax, nextStep) => {
      input.min = String(nextMin);
      input.max = String(nextMax);
      input.step = String(nextStep);
    },
    setValue: (nextValue) => {
      input.value = String(nextValue);
      valueText.textContent = String(nextValue);
    }
  };
}
