import { setIcon, setTooltip } from "obsidian";

let dwellTooltip: HTMLDivElement | null = null;

function hideDwellTooltip(): void {
  dwellTooltip?.remove();
  dwellTooltip = null;
}

export function setControlTooltip(element: HTMLElement, label: string): void {
  element.setAttribute("aria-label", label);
  element.dataset.handNoteTooltip = label;
  setTooltip(element, label);
  if (element.dataset.handNoteDwellBound === "true") {
    return;
  }
  element.dataset.handNoteDwellBound = "true";
  let timer: number | null = null;
  let startX = 0;
  let startY = 0;
  const cancel = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    hideDwellTooltip();
  };
  element.addEventListener("pointerenter", (event) => {
    if (event.pointerType !== "pen" || event.buttons !== 0) {
      return;
    }
    startX = event.clientX;
    startY = event.clientY;
    timer = window.setTimeout(() => {
      const text = element.dataset.handNoteTooltip;
      if (!text) {
        return;
      }
      hideDwellTooltip();
      const rect = element.getBoundingClientRect();
      dwellTooltip = document.createElement("div");
      dwellTooltip.className = "hand-note-dwell-tooltip";
      dwellTooltip.textContent = text;
      document.body.append(dwellTooltip);
      const tooltipRect = dwellTooltip.getBoundingClientRect();
      const left = Math.max(
        8,
        Math.min(window.innerWidth - tooltipRect.width - 8, rect.left + rect.width / 2 - tooltipRect.width / 2)
      );
      const top = rect.bottom + tooltipRect.height + 10 <= window.innerHeight
        ? rect.bottom + 6
        : rect.top - tooltipRect.height - 6;
      dwellTooltip.style.left = `${left}px`;
      dwellTooltip.style.top = `${Math.max(8, top)}px`;
      timer = null;
    }, 550);
  });
  element.addEventListener("pointermove", (event) => {
    if (
      event.pointerType !== "pen" ||
      event.buttons !== 0 ||
      Math.hypot(event.clientX - startX, event.clientY - startY) > 10
    ) {
      cancel();
    }
  });
  element.addEventListener("pointerleave", cancel);
  element.addEventListener("pointerdown", cancel);
}

export function createIconButton(icon: string, label: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "clickable-icon hand-note-tool";
  setIcon(button, icon);
  setControlTooltip(button, label);
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
