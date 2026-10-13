import { Route, Routes } from "react-router";

import { Layout, useDarkMode } from "./components/Layout.tsx";
import { ProblemList } from "./pages/ProblemList.tsx";
import { ProblemPage } from "./pages/ProblemPage.tsx";

export function App() {
  const { dark, toggle } = useDarkMode();
  return (
    <Layout dark={dark} onToggleDark={toggle}>
      <Routes>
        <Route path="/" element={<ProblemList />} />
        <Route path="/problems/:slug" element={<ProblemPage dark={dark} />} />
        <Route path="*" element={<p className="p-4">Page not found.</p>} />
      </Routes>
    </Layout>
  );
}
