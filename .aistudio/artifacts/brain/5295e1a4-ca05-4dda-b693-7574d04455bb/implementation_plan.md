# Fix Invalid SVG DOM Property Warnings in Header

This update resolves the React runtime console warning (`Warning: Invalid DOM property stroke-width. Did you mean strokeWidth?`) by replacing kebab-case SVG attributes (`stroke-width`) with React-compliant camelCase (`strokeWidth`) across the navigation header icons.

## User Review & Critical Decisions

> [!NOTE]
> No functional or visual design changes are introduced; this fix strictly resolves the React JSX DOM property warning in the top navigation bar.

- **Confirmed Decision**: Convert all remaining `stroke-width="2"` attributes on `<svg>` elements inside the Header component to `strokeWidth="2"`.

## 1. Overview & Core Concept

- **What It Does**: Eliminates React DOM validation warnings rendered when mounting the application header icons (Brand Logo, Backup icon, and Sound On/Off icons).
- **Target Audience / Persona**: Players and Bankers using the Business Game Banker console.
- **Key Value**: Clean runtime execution with zero React DOM property warnings and consistent SVG stroke rendering.

## 2. User Experience & Visual Design

- **Key User Flows**: Header renders immediately on application load with crisp 2px stroke SVG icons for the brand emblem, Backup button, and Sound toggle button.
- **Visual Identity & Theme**: Preserves the existing dark-slate (`#0b0f19`) and emerald (`#10b981`) banker console aesthetic without any visual changes.
- **Interactive Feedback & Motion**: Sound toggle and Backup modal triggers remain responsive with zero console noise.

## 3. Key Product Decisions & Trade-Offs

- **Decision 1**: Standardize JSX SVG attributes to camelCase.
  - *Chosen Approach*: Replace `stroke-width` with `strokeWidth` on all four `<svg>` elements in the Header component.
  - *Why*: React JSX requires camelCase for multi-word SVG attributes (`strokeWidth`, `strokeLinecap`, `strokeLinejoin`) to avoid runtime DOM warnings.

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

```
┌──────────────────────────────────────────────────────────┐
│                        App Shell                         │
├──────────────────────────────────────────────────────────┤
│  Header Navigation Bar                                   │
│  ├── Brand Logo SVG        (strokeWidth="2")             │
│  ├── Backup Action SVG     (strokeWidth="2")             │
│  └── Sound Toggle SVGs     (strokeWidth="2" On & Off)    │
└──────────────────────────────────────────────────────────┘
```

- **Data Model & State**: No changes to `GameContext` or IndexedDB storage.
- **Interactive Component & State Mapping**: The Header component's `toggleSound` and `openModal('backup')` handlers continue to operate identically while rendering valid React SVG props.
