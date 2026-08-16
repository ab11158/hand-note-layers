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

export function createLabeledSlider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  onChange: (value: number) => void
): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.className = "hand-note-slider";

  const text = document.createElement("span");
  text.textContent = label;

  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => onChange(Number(input.value)));

  wrapper.append(text, input);
  return wrapper;
}
