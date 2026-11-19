import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, MotionConfig, domMin } from "motion/react";
import App from "./App";
import "./index.css";
import "./fonts/base.css";
import "./lib/appearance";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* 움직임은 m.* 과 domMin(나타나기·사라지기)만 싣는다. 끌기·레이아웃 같은 무거운 기능은 쓰지 않는다.
        reducedMotion: 운영체제에서 동작을 줄여 두었으면 자리가 움직이는 것은 끄고 흐려지는 것만 남긴다. */}
    <LazyMotion features={domMin}>
      <MotionConfig reducedMotion="user">
        <App />
      </MotionConfig>
    </LazyMotion>
  </StrictMode>,
);
