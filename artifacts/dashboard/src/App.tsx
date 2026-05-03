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
import Settings from "@/pages/settings";
import Leaderboard from "@/pages/leaderboard";
import KycReview from "@/pages/kyc";
import Monitor from "@/pages/monitor";
import UsersPage from "@/pages/users";
import SubscriptionsPage from "@/pages/subscriptions";
import ReportsPage from "@/pages/reports";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Redirect to="/login" />;
  return (
    <Layout>
      <Component />
    </Layout>
  );
}

const ProtectedDashboard      = () => <ProtectedRoute component={Dashboard} />;
const ProtectedLeads          = () => <ProtectedRoute component={Leads} />;
const ProtectedLeadDetail     = () => <ProtectedRoute component={LeadDetail} />;
const ProtectedCalls          = () => <ProtectedRoute component={Calls} />;
const ProtectedAgentSettings  = () => <ProtectedRoute component={AgentSettings} />;
const ProtectedSettings       = () => <ProtectedRoute component={Settings} />;
const ProtectedLeaderboard    = () => <ProtectedRoute component={Leaderboard} />;
const ProtectedKycReview      = () => <ProtectedRoute component={KycReview} />;
const ProtectedMonitor        = () => <ProtectedRoute component={Monitor} />;
const ProtectedUsers          = () => <ProtectedRoute component={UsersPage} />;
const ProtectedSubscriptions  = () => <ProtectedRoute component={SubscriptionsPage} />;
const ProtectedReports        = () => <ProtectedRoute component={ReportsPage} />;

function Router() {
  return (
    <Switch>
      <Route path="/login"          component={Login} />
      <Route path="/register"       component={Register} />
      <Route path="/"               component={ProtectedDashboard} />
      <Route path="/dashboard"      component={ProtectedDashboard} />
      <Route path="/leads"          component={ProtectedLeads} />
      <Route path="/leads/:id"      component={ProtectedLeadDetail} />
      <Route path="/calls"          component={ProtectedCalls} />
      <Route path="/agent"          component={ProtectedAgentSettings} />
      <Route path="/settings"       component={ProtectedSettings} />
      <Route path="/leaderboard"    component={ProtectedLeaderboard} />
      <Route path="/kyc"            component={ProtectedKycReview} />
      <Route path="/monitor"        component={ProtectedMonitor} />
      <Route path="/users"          component={ProtectedUsers} />
      <Route path="/subscriptions"  component={ProtectedSubscriptions} />
      <Route path="/reports"        component={ProtectedReports} />
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
