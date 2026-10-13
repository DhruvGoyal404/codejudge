import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// The first render of a file can be slow while modules are transformed (cold
// start, busy machine); the 1 s default made findBy* flaky.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => cleanup());
