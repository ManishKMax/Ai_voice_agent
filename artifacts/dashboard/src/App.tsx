import React from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Layout } from "@/components/layout";
import { Redirect } from "wouter";

import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Register from "@/pages/register";
import Dashboard from "@/pages/dashboard";
import Leads from "@/pages/leads";
import LeadDetail from "@/pages/lead-detail";
import Calls from "@/pages/calls";
import AgentSettings from "@/pages/agent";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Stable wrapper — not recreated on every render
function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Redirect to="/login" />;
  return (
    <Layout>
      <Component />
    </Layout>
  );
}

// Pre-bind stable route components so Wouter never sees a new type reference
const ProtectedDashboard = () => <ProtectedRoute component={Dashboard} />;
const ProtectedLeads = () => <ProtectedRoute component={Leads} />;
const ProtectedLeadDetail = () => <ProtectedRoute component={LeadDetail} />;
const ProtectedCalls = () => <ProtectedRoute component={Calls} />;
const ProtectedAgentSettings = () => <ProtectedRoute component={AgentSettings} />;

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/register" component={Register} />
      <Route path="/" component={ProtectedDashboard} />
      <Route path="/dashboard" component={ProtectedDashboard} />
      <Route path="/leads" component={ProtectedLeads} />
      <Route path="/leads/:id" component={ProtectedLeadDetail} />
      <Route path="/calls" component={ProtectedCalls} />
      <Route path="/agent" component={ProtectedAgentSettings} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <AuthProvider>
            <Router />
          </AuthProvider>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
