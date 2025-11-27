# Component Styling Patterns

Reusable component patterns from the EditTrax design system. Use these as templates for maintaining consistent styling across projects.

## 🔘 Buttons

### Primary Button (Yellow)
```jsx
<button className="outline_button_main bg-yellow-75 text-center w-34 py-4 px-11 mt-0 text-black rounded-md mb-4 shadow-2xl font-mathias">
  Button Text
</button>
```

**CSS Class**:
```css
.outline_button_main {
  display: flex;
  justify-content: center;
  align-items: center;
}
```

### Edit Button
```jsx
<button className="edit_button px-4 py-2">
  Edit
</button>
```

**CSS Class**:
```css
.edit_button {
  margin-top: 1rem;
  border: 0;
  vertical-align: middle;
  border-color: #f6e05e;
  background-color: #7f1d1d;
  padding-top: 0.5rem;
  color: #e6e9e0;
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
  line-height: 0.75rem;
  border-radius: 0.375rem;
  padding-bottom: 0.25rem;
  margin-bottom: auto;
  text-align: center;
  font-family: 'Mathias', sans-serif;
  font-size: 0.75rem;
  font-weight: 600;
}
```

### Edit Button (Muted/Disabled)
```jsx
<button className="edit_button_muted px-4 py-2" disabled>
  Edit
</button>
```

**CSS Class**:
```css
.edit_button_muted {
  /* Same as edit_button plus: */
  opacity: 0.25;
}
```

### Expandable Button
```jsx
<button className="expandable_button">
  Click to Expand
</button>
```

**CSS Class**:
```css
.expandable_button {
  text-align: center;
  margin-top: 0px;
  width: 100%;
  min-height: 70px;
  font-family: mathias;
  border: solid black 2px;
  padding-top: 8px;
  padding-left: 10px;
  padding-right: 10px;
}
```

### Checkout Button
```css
.checkoutBg {
  background: #8EA461;
}
```

### Sold Out Button
```css
.soldoutBg {
  background: #373935;
}
```

## 🔐 Wallet Connect Buttons

### Tezos Wallet Button (Full)
```jsx
<button className="login-with-tezos py-4 px-12 text-yellow-75 rounded-md">
  Connect Wallet
</button>
```

**CSS Class**:
```css
.login-with-tezos {
  transition: background-color .3s, box-shadow .3s;
  border-radius: 5px;
  box-shadow: 0 -1px 0 rgba(0, 0, 0, .04), 0 1px 1px rgba(0, 0, 0, .25);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
  text-align: right;
  background-image: url(data:image/svg+xml;base64,...); /* Tezos icon */
  background-color: #175C72;
  background-repeat: no-repeat;
  background-position: 15px 20px;
}
```

### Tezos Wallet Button (Navigation)
```jsx
<button className="login-with-tezos-nav py-2 px-4">
  Connect
</button>
```

**CSS Class**:
```css
.login-with-tezos-nav {
  transition: background-color .3s, box-shadow .3s;
  border-radius: 5px;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
  width: 160px;
  background-image: url(data:image/svg+xml;base64,...); /* Tezos icon */
  background-repeat: no-repeat;
  background-position: 8px 8px;
}
```

### Google Login Button
```jsx
<button className="login-with-google-btn py-4 px-12">
  Sign in with Google
</button>
```

**CSS Class**:
```css
.login-with-google-btn {
  transition: background-color .3s, box-shadow .3s;
  border: 2px solid;
  border-radius: 5px;
  box-shadow: 0 -1px 0 rgba(0, 0, 0, .04), 0 1px 1px rgba(0, 0, 0, .25);
  color: #333333;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
  text-align: right;
  background-image: url(data:image/svg+xml;base64,...); /* Google icon */
  background-color: rgb(255, 255, 255);
  background-repeat: no-repeat;
  background-position: 15px 25px;
}
```

## 📑 Cards & Containers

### Standard Card
```jsx
<div className="bg-black border-2 border-black rounded-md p-4 shadow-5xl">
  {/* Card content */}
</div>
```

### Modal Container
```jsx
<div className="modal">
  <div className="modal-bg"></div>
  <div className="modal-content">
    {/* Modal content */}
  </div>
</div>
```

**CSS Classes**:
```css
.modal {
  position: fixed;
  top: 0;
  left: 0;
  opacity: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100vh;
  z-index: 10;
  padding: 20px;
}

.modal-bg {
  position: fixed;
  top: 0;
  left: 0;
  opacity: 1;
  width: 100%;
  height: 100vh;
  z-index: 10;
  background-color: rgba(0, 0, 0, 0.78);
}

.modal-content {
  background-color: black;
  width: 500px;
  position: relative;
  z-index: 9999;
  max-width: 90vw;
}
```

### Sign-in Modal (Full Black)
```css
.modal-bg-signin {
  position: fixed;
  top: 0;
  left: 0;
  opacity: 1;
  width: 100%;
  height: 100vh;
  z-index: 10;
  background-color: rgb(0, 0, 0); /* Solid black */
}
```

## 🎵 Media Player Components

### Release Player Container
```jsx
<div className="releasePlayer">
  {/* Player controls */}
</div>
```

**CSS Class**:
```css
.releasePlayer {
  position: relative;
  display: flex;
  justify-content: center;
  height: 100%;
  width: 100%;
  background: rgb(45, 45, 45);
  border-radius: 5px;
  border-color: transparent !important;
  padding: 5px;
}
```

### Play Button Container
```jsx
<div className="playButtonCont">
  {/* Play icon */}
</div>
```

**CSS Class**:
```css
.playButtonCont {
  height: 5rem;
  width: 5rem;
  color: black;
  text-align: center;
  border-radius: 0.375rem;
  padding: 20px;
  margin: auto !important;
}
```

### Player with Tezos Price
```jsx
<div className="player-with-tezos-price">
  {/* Price display */}
</div>
```

**CSS Class**:
```css
.player-with-tezos-price {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif;
  background-image: url(data:image/svg+xml;base64,...); /* Tezos icon */
  background-repeat: no-repeat;
  background-position: 4px 4px;
  width: 105px;
  padding-left: 17px;
  padding-top: 4px;
  height: 32px;
}
```

## 📱 Navigation

### Tabbed Menu
```jsx
<div className="w-full">
  <ul className="flex">
    <li className="w-full px-4 py-2 py-4 w-full px-2 lg:px-6 cursor-pointer rounded-t-lg shadow-sm font-mathias text-sm lg:text-xl border-black border-3 bg-black text-yellow-75 text-center">
      Active Tab
    </li>
    <li className="w-full px-4 py-2 py-4 w-full px-2 lg:px-6 cursor-pointer rounded-t-lg shadow-sm font-mathias text-sm lg:text-xl border-black border-3 bg-yellow-75 text-gray-800 outline_tabbed_menu text-center">
      Inactive Tab
    </li>
  </ul>
  <div className="m-4 mt-0 outline_tabbed_menu w-full bg-black rounded-b-lg">
    {/* Tab content */}
  </div>
</div>
```

**CSS Class**:
```css
.outline_tabbed_menu {
  border: solid black 2px;
  margin-left: auto;
  margin-right: auto;
}
```

## 📋 Text Patterns

### Release Name (Primary)
```jsx
<h2 className="release_name">
  Release Title
</h2>
```

**CSS Class**:
```css
.release_name {
  font-family: 'Mathias', sans-serif;
  font-size: 1rem;
  padding-top: 0.25rem;
  font-weight: 600;
  color: #e6e9e0;
  text-align: left;
  line-height: 100%;
}
```

### Release Name (Subtitle)
```jsx
<p className="release_namesub">
  Artist Name
</p>
```

**CSS Class**:
```css
.release_namesub {
  font-family: 'Mathias', sans-serif;
  font-size: 0.75rem;
  padding-top: 0.25rem;
  font-weight: 400;
  color: #e6e9e087; /* 53% opacity */
  text-align: left;
  line-height: 100%;
}
```

### Headline Hero
```jsx
<h1 className="headline_hero font-mathias text-4xl">
  Big Hero Text
</h1>
```

**CSS Class**:
```css
.headline_hero {
  line-height: 30px;
}
```

### Navigation Tagline
```jsx
<span className="nav_tagline">
  Tagline Text
</span>
```

**CSS Class**:
```css
.nav_tagline {
  font-size: 10px;
  line-height: 100%;
  padding-left: 128px;
}
```

### Custom Line Height
```jsx
<p className="custom-line-height">
  Tight line height text
</p>
```

**CSS Class**:
```css
.custom-line-height {
  font-size: 14px;
  line-height: 100%;
}
```

## 🎪 Collapsible/Dropdown

### Release Dropdown Container
```jsx
<div className="releaseDropdown">
  <div className="releaseDropdown__trigger">
    {/* Trigger content */}
  </div>
  <div className="releaseDropdown__contentOuter">
    {/* Dropdown content */}
  </div>
</div>
```

**CSS Classes**:
```css
.releaseDropdown {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-direction: column;
  min-height: 70px;
}

.releaseDropdown__trigger {
  display: flex;
  justify-content: center;
  align-items: center;
  font-family: mathias;
  width: 100%;
  line-height: 18px;
}

.releaseDropdown__contentOuter {
  width: 100%;
}
```

### Collapsible Component
```jsx
<div className="Collapsible">
  <div className="Collapsible__contentInner">
    {/* Content */}
  </div>
</div>
```

**CSS Classes**:
```css
.Collapsible {
  font-family: mathias;
  font-size: 23px;
}

.Collapsible__contentInner {
  font-family: Arial, Helvetica, sans-serif;
  text-align: center;
}
```

## 🎨 Banner Sections

### Homepage Banner
```jsx
<div className="banner">
  {/* Banner content */}
</div>
```

**CSS Class**:
```css
.banner {
  background-color: transparent;
  height: 30vh;
  background-image: url(assets/homepage_c.jpg);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  max-width: 100%;
}
```

### Alternative Banner
```jsx
<div className="banner_2">
  {/* Banner content */}
</div>
```

**CSS Class**:
```css
.banner_2 {
  background-color: transparent;
  height: 30vh;
  background-image: url(assets/banner_homepage.png);
  background-position: center;
  background-size: cover;
  background-repeat: no-repeat;
  max-width: 100%;
}
```

## 🖼️ Image Containers

### Main Image
```jsx
<img className="main_image" src={imageSrc} alt="Main content" />
```

**CSS Class**:
```css
.main_image {
  width: 700px;
  max-width: 90vw;
}
```

### Origin Image
```jsx
<img className="origImg" src={imageSrc} alt="Original" />
```

**CSS Class**:
```css
.origImg {
  width: 110px;
}
```

## 📐 Layout Utilities

### Center Horizontal
```jsx
<div className="centerHoriz">
  {/* Centered content */}
</div>
```

**CSS Class**:
```css
.centerHoriz {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
}
```

### User Dashboard Max Width
```jsx
<div className="userDashMaxWidth90vw">
  {/* Dashboard content */}
</div>
```

**CSS Class**:
```css
.userDashMaxWidth90vw {
  max-width: 90vw;
}
```

## 🔧 Footer Pattern

```jsx
<footer className="bg-black p-10 dark:bg-gray-900 lg:mt-18">
  <div className="md:flex md:justify-between">
    <div className="mb-6 md:mb-0 flex flex-col align-middle items-center sm:items-start mb-24">
      <a href="/" className="flex items-center">
        <img src={logo} alt="logo" className="w-44 mb-8 ms:mb-0 w-42 mt-8 sm:w-44" />
      </a>
    </div>
    <div className="grid grid-cols-1 gap-2 sm:gap-8 sm:grid-cols-4 text-center md:text-left">
      {/* Footer sections */}
    </div>
  </div>
  <hr className="my-6 text-yellow-75 sm:mx-auto lg:my-8" />
  <div className="flex col w-full items-center content-center flex-col md:flex-row sm:flex sm:items-start sm:justify-between lg:content-justify">
    {/* Footer bottom content */}
  </div>
</footer>
```

## 🎯 Common Class Combinations

### Primary CTA Button
```jsx
className="bg-yellow-75 text-black font-mathias px-6 py-3 rounded-md border-2 border-black shadow-2xl hover:bg-yellow-125 transition-all"
```

### Secondary Button
```jsx
className="bg-black text-yellow-75 font-mathias px-6 py-3 rounded-md border-2 border-yellow-75 shadow-lg hover:shadow-xl transition-all"
```

### Card Container
```jsx
className="bg-black border-2 border-black rounded-md p-6 shadow-5xl"
```

### Section Header
```jsx
className="font-mathias text-xl lg:text-3xl text-yellow-75 mb-6 uppercase"
```

### Body Text
```jsx
className="text-gray-400 text-sm lg:text-base leading-normal"
```

## 📝 Implementation Notes

1. **Always use `font-mathias`** for branded elements (buttons, headings, navigation)
2. **Combine Tailwind utilities** with custom CSS classes when needed
3. **Maintain consistent spacing** using the defined spacing scale
4. **Use shadow-5xl** for primary depth effects
5. **Keep line-heights tight** (90-100%) for Mathias font
6. **Default to black backgrounds** with light text
7. **Use yellow-75** for primary accents and CTAs
8. **Apply transitions** for interactive elements (0.3s standard)

## 🔄 Responsive Patterns

### Mobile-First Flex Layout
```jsx
<div className="flex flex-col md:flex-row items-center md:items-start gap-4">
  {/* Responsive content */}
</div>
```

### Responsive Text Sizing
```jsx
<h1 className="text-xl sm:text-2xl lg:text-4xl font-mathias">
  Responsive Heading
</h1>
```

### Responsive Padding
```jsx
<div className="p-4 sm:p-6 lg:p-10">
  {/* Responsive padding */}
</div>
```

## 🎨 State Variations

### Hover States
```css
/* Buttons */
hover:bg-yellow-125
hover:shadow-xl
hover:scale-105

/* Text */
hover:text-gray-900
hover:underline
```

### Focus States
```css
focus:outline-none
focus:ring-2
focus:ring-yellow-75
focus:ring-offset-2
focus:ring-offset-black
```

### Disabled States
```css
disabled:opacity-25
disabled:cursor-not-allowed
disabled:pointer-events-none
```

**Last Updated**: November 27, 2025

