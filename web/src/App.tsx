import { Route, Routes } from "react-router";

import { Layout, useDarkMode } from "./components/Layout.tsx";
import { Landing } from "./pages/Landing.tsx";
import { NotFound } from "./pages/NotFound.tsx";
import { ProblemList } from "./pages/ProblemList.tsx";
import { ProblemPage } from "./pages/ProblemPage.tsx";
import { ProfilePage } from "./pages/ProfilePage.tsx";
import { SubmissionPage } from "./pages/SubmissionPage.tsx";

export function App() {
  const { dark, toggle } = useDarkMode();
  return (
    <Layout dark={dark} onToggleDark={toggle}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/problems" element={<ProblemList />} />
        <Route path="/problems/:slug" element={<ProblemPage dark={dark} />} />
        <Route path="/submissions/:id" element={<SubmissionPage dark={dark} />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Layout>
  );
}
