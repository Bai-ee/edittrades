# Cursor AI Integration Guide

This guide explains how to effectively use the EditTrax style guide with Cursor AI to maintain design consistency across projects.

## 🤖 How to Use with Cursor

### Method 1: Reference in Prompts

When asking Cursor to create or modify components, reference the style guide:

```
"Create a primary CTA button using the styles from style-guide/QUICK-REFERENCE.md"

"Apply the card pattern from style-guide/component-patterns.md to this component"

"Use the color palette from style-guide/design-tokens.md for this section"
```

### Method 2: Open Relevant Files

Keep these files open in your editor while working:

1. **QUICK-REFERENCE.md** - For fast lookups
2. **component-patterns.md** - When building UI components
3. **design-tokens.md** - For detailed values

Cursor will have context from open files and can reference them automatically.

### Method 3: Copy Configuration

For new projects, ask Cursor:

```
"Copy the Tailwind configuration from style-guide/tailwind-config.js to my project"

"Set up the font imports from style-guide/css-variables.css"

"Copy all logo assets from style-guide/logos/ to my public folder"
```

## 💡 Effective Prompts

### Creating Components

**Good Prompt:**
```
Create a primary button component using:
- bg-yellow-75 text-black from our color palette
- font-mathias for text
- border-2 border-black
- rounded-md
- shadow-2xl
- hover state with bg-yellow-125
```

**Better Prompt:**
```
Create a primary button component using the EditTrax design system.
Reference style-guide/QUICK-REFERENCE.md for the "Primary CTA" button recipe.
```

**Best Prompt:**
```
Create a primary button component matching the EditTrax brand.
Use the button recipe from QUICK-REFERENCE.md and ensure:
1. Mathias font with tight line-height
2. Proper hover states
3. Consistent with existing buttons in the codebase
```

### Styling Existing Components

**Good Prompt:**
```
Apply EditTrax styling to this card component using our design tokens
```

**Better Prompt:**
```
Restyle this card component using the Card Recipe from style-guide/QUICK-REFERENCE.md
```

**Best Prompt:**
```
Apply EditTrax brand styling to this card:
1. Use the card pattern from component-patterns.md
2. Match the shadow-5xl signature depth
3. Ensure responsive padding (p-4 sm:p-6)
4. Maintain accessibility standards
```

### Color Application

**Good Prompt:**
```
Update colors to match EditTrax brand
```

**Better Prompt:**
```
Apply EditTrax color palette:
- Background: black
- Text: yellow-75
- Accents: yellow-125 for hovers
Reference design-tokens.md for exact values
```

### Responsive Design

**Good Prompt:**
```
Make this component responsive
```

**Better Prompt:**
```
Apply EditTrax responsive patterns from component-patterns.md:
- Mobile-first approach
- Breakpoints: sm, laptop, lg
- Use responsive text sizing (text-xl sm:text-2xl lg:text-4xl)
```

## 📚 Context Loading Strategies

### For Small Changes
```
"Update button colors using values from QUICK-REFERENCE.md"
```

### For Component Creation
```
"Create a modal component following the patterns in component-patterns.md,
using colors from design-tokens.md"
```

### For Full Page Design
```
"Design a landing page using EditTrax design system:
1. Reference QUICK-REFERENCE.md for common patterns
2. Use component-patterns.md for card, button, and modal styles
3. Follow the responsive approach from tailwind-config.js
4. Maintain the black background theme with yellow-75 accents"
```

## 🎯 Specific Use Cases

### Use Case 1: New Button

**Prompt:**
```
Create a new button variant for [action name] that:
1. Follows EditTrax button patterns (component-patterns.md)
2. Uses appropriate colors (primary: yellow-75, secondary: blue-460)
3. Includes hover and disabled states
4. Is fully responsive
```

### Use Case 2: Form Styling

**Prompt:**
```
Style this form using EditTrax design system:
- Input fields: black bg, yellow-75 border, 2px
- Labels: Mathias font, yellow-75 color
- Buttons: Use Primary CTA recipe from QUICK-REFERENCE.md
- Error states: red-75 color
- Reference design-tokens.md for exact values
```

### Use Case 3: Dashboard Layout

**Prompt:**
```
Create a dashboard layout using EditTrax patterns:
1. Use the card pattern for each widget (component-patterns.md)
2. Grid layout: 1 col mobile, 2 col tablet, 3 col desktop
3. Navigation with Tabbed Menu pattern
4. Color scheme: black background, yellow-75 accents
5. All spacing from design-tokens.md spacing scale
```

### Use Case 4: Modal Dialog

**Prompt:**
```
Implement a modal dialog using:
- Modal recipe from QUICK-REFERENCE.md
- Background overlay: rgba(0,0,0,0.78)
- Content container: black with shadow-5xl
- Close button: Use secondary button style
- Centered, responsive (max-width: 90vw)
```

## 🔄 Refactoring with Style Guide

### Existing Component Refactor

**Prompt:**
```
Refactor [ComponentName] to match EditTrax design system:

Current issues:
- Inconsistent colors
- Wrong font family
- No shadow depth
- Incorrect spacing

Apply:
1. Colors from design-tokens.md
2. Mathias font for headings
3. shadow-5xl for depth
4. spacing-6 for padding
5. Ensure responsive behavior

Keep existing functionality, only update styling.
```

### Global Style Update

**Prompt:**
```
Update all button styles across the project to match EditTrax standards:

Reference: component-patterns.md "Buttons" section

Changes needed:
1. Primary buttons: bg-yellow-75, text-black, font-mathias
2. Secondary buttons: bg-black, text-yellow-75, border-2
3. All buttons: rounded-md, shadow-2xl
4. Hover states: bg-yellow-125 for primary
5. Consistent padding: px-6 py-3

List all files that need updates first, then proceed with changes.
```

## 📋 Checklist Prompts

### Component Checklist

```
Review this component against EditTrax design standards:

Color ✓/✗
- [ ] Uses approved color palette (design-tokens.md)
- [ ] Yellow-75 for accents
- [ ] Black backgrounds

Typography ✓/✗
- [ ] Mathias font for headings/buttons
- [ ] Tight line-height (leading-90) for Mathias
- [ ] Correct font sizes (design-tokens.md)

Spacing ✓/✗
- [ ] Uses standard spacing scale
- [ ] Consistent padding/margins
- [ ] Proper gap in grids

Borders & Shadows ✓/✗
- [ ] 2px borders (standard)
- [ ] Appropriate border-radius
- [ ] shadow-5xl for depth

Responsive ✓/✗
- [ ] Mobile-first approach
- [ ] Uses defined breakpoints
- [ ] Responsive text/spacing

Report any issues found and suggest fixes.
```

## 🛠️ Advanced Integration

### Multi-File Updates

**Prompt:**
```
Update design tokens across multiple files:

1. Read current values from style-guide/design-tokens.md
2. Find all hardcoded color values in src/
3. Replace with Tailwind classes or CSS variables
4. Generate a report of changes made
5. Test that no styling is broken

Focus on:
- Color values (#E6E9E0, #000000, etc.)
- Font sizes (16px, 1rem, etc.)
- Spacing values (padding, margin)
```

### Component Library Generation

**Prompt:**
```
Generate a component library based on EditTrax style guide:

Components needed:
1. Button variants (Primary, Secondary, Edit, Wallet)
2. Card component with variants
3. Modal component
4. Input fields (text, textarea, select)
5. Navigation tabs
6. Footer

For each component:
- Use patterns from component-patterns.md
- Include TypeScript types
- Add prop variants for different states
- Include usage examples
- Ensure full accessibility (ARIA labels)
- Document in Storybook format

Create in: src/components/design-system/
```

## 📖 Documentation Generation

**Prompt:**
```
Generate component documentation for [ComponentName]:

Include:
1. Component overview
2. Props/API reference
3. Usage examples with code
4. Design tokens used (reference design-tokens.md)
5. Accessibility notes
6. Responsive behavior
7. Related components

Format: MDX for Storybook
Style: Match the style guide documentation format
```

## 🎨 Asset Management

### Using Logos

**Prompt:**
```
Update logo usage across the application:

Available logos (in style-guide/logos/):
1. logo.svg - Favicon (16x16, 32x32)
2. et_horizontal.png - Navigation/Footer (w-44)
3. et_new_logo.png - Hero sections

Update:
- Favicon in public/index.html
- Navigation logo with proper sizing
- Footer logo with responsive classes
- Hero section logo

Ensure proper alt text and lazy loading.
```

### Background Images

**Prompt:**
```
Apply EditTrax background images from style-guide/images/:

1. homepage_bg.png - Homepage slider
   - background-position: center
   - background-size: cover
   - background-repeat: no-repeat

2. loader_bg.png - Loading screens
   - background-position: center
   - background-size: contain

3. banner_homepage.png - Banner sections
   - Apply to [section name]
   - Full width, 30vh height

Update components: [list components]
```

## 🚨 Common Pitfalls to Avoid

### ❌ Bad Prompt
```
"Make it look like the design system"
```
**Too vague - Cursor doesn't know which specific patterns to apply**

### ✅ Good Prompt
```
"Apply the Primary CTA button style from QUICK-REFERENCE.md:
bg-yellow-75, text-black, font-mathias, border-2, shadow-2xl"
```

---

### ❌ Bad Prompt
```
"Use the brand colors"
```
**Unclear which colors and where to apply them**

### ✅ Good Prompt
```
"Apply EditTrax color scheme from design-tokens.md:
- Background: black (#000000)
- Primary text: yellow-75 (#E6E9E0)
- Accent/hover: yellow-125 (#A6752B)
- Borders: yellow-75"
```

---

### ❌ Bad Prompt
```
"Make it responsive"
```
**No context on breakpoints or approach**

### ✅ Good Prompt
```
"Apply EditTrax responsive patterns using mobile-first approach:
- text-xl sm:text-2xl lg:text-4xl
- p-4 sm:p-6 lg:p-10
- Breakpoints: sm (640px), laptop (920px), lg (1024px)
Reference: component-patterns.md responsive section"
```

## 💾 Saving Conversations

When Cursor creates components that perfectly match the style guide:

1. **Save the prompt** for future reference
2. **Document the component** in your project
3. **Update style guide** if new patterns emerge
4. **Share with team** for consistency

## 🔄 Iterative Refinement

**Initial Prompt:**
```
Create a card component using EditTrax styles
```

**Refinement 1:**
```
Adjust the card to use shadow-5xl instead of shadow-2xl
Reference: design-tokens.md shows shadow-5xl is our signature depth
```

**Refinement 2:**
```
Add responsive padding: p-4 sm:p-6 lg:p-10
Ensure borders are border-2 (not border-1)
```

**Refinement 3:**
```
Perfect! Now create variants:
- CardPrimary (current)
- CardSecondary (lighter background: blue-900)
- CardHighlight (yellow-75 border)
All following EditTrax patterns
```

## 📊 Measuring Consistency

**Audit Prompt:**
```
Audit the current application against EditTrax design system:

Check:
1. Color usage - are we only using approved colors?
2. Typography - is Mathias used consistently?
3. Spacing - using the defined scale?
4. Shadows - using shadow-5xl appropriately?
5. Borders - 2px standard width?
6. Border radius - using approved values?

Generate report with:
- Compliance percentage
- List of violations
- Suggested fixes
- Priority order

Reference: design-tokens.md for all approved values
```

## 🎯 Pro Tips

1. **Always reference specific files** - "from QUICK-REFERENCE.md" is clearer than "from the style guide"

2. **Be specific about values** - "shadow-5xl" is better than "add shadow"

3. **Provide context** - Explain WHY you're applying certain styles

4. **Use layered prompts** - Start broad, then refine with specific details

5. **Reference examples** - "Like the button in Footer.tsx but with different text"

6. **Ask for explanations** - "Why did you choose shadow-2xl instead of shadow-5xl?"

7. **Save successful patterns** - Document what works well for your team

## 📱 Quick Commands

### Setup New Project
```
Set up EditTrax design system in this project:
1. Copy style-guide/tailwind-config.js to ./tailwind.config.js
2. Copy fonts from style-guide/fonts/ to ./src/fonts/
3. Create @font-face declaration for Mathias
4. Set up base styles with black background
5. Install required dependencies
6. Create initial components folder structure
```

### Apply to Existing Component
```
Apply EditTrax styles to [ComponentName.tsx]:
Reference: component-patterns.md [pattern name]
Maintain existing functionality, update only styling
```

### Create New Feature
```
Create [feature name] using EditTrax design system:
- Layout: [describe layout]
- Components needed: [list]
- Reference appropriate patterns from component-patterns.md
- Ensure mobile-responsive
- Use approved color palette
```

## 📚 Further Reading

- **QUICK-REFERENCE.md** - Fast value lookups
- **design-tokens.md** - Complete token reference
- **component-patterns.md** - Reusable patterns
- **README.md** - Overview and setup guide

---

**Remember:** The more specific and detailed your prompts, the better Cursor can help you maintain design consistency! 🎨

**Last Updated**: November 27, 2025

