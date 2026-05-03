import { Link } from "wouter";
import { ArrowLeft, PhoneCall, Plus, Upload } from "lucide-react";

export default function Leads() {
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link to="/dashboard" className="flex items-center gap-2 text-gray-500 hover:text-gray-900 text-sm font-medium transition-colors">
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm font-semibold text-gray-900">Leads</span>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Leads</h1>
            <p className="text-gray-500 text-sm mt-1">Manage your calling campaign leads</p>
          </div>
          <div className="flex items-center gap-2">
            <button className="flex items-center gap-2 border border-gray-200 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors">
              <Upload className="h-4 w-4" />
              Import CSV
            </button>
            <button className="flex items-center gap-2 bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-semibold hover:bg-indigo-700 transition-colors">
              <Plus className="h-4 w-4" />
              Add Lead
            </button>
          </div>
        </div>

        {/* Empty state */}
        <div className="bg-white border border-gray-100 rounded-2xl p-16 text-center">
          <div className="h-14 w-14 bg-indigo-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <PhoneCall className="h-7 w-7 text-indigo-400" />
          </div>
          <h3 className="font-semibold text-gray-900 mb-2">No leads yet</h3>
          <p className="text-sm text-gray-500 mb-6 max-w-sm mx-auto">
            Add your first lead to start your AI calling campaign. You can add leads one by one or import a CSV file.
          </p>
          <button className="inline-flex items-center gap-2 bg-indigo-600 text-white px-5 py-2.5 rounded-xl font-semibold hover:bg-indigo-700 transition-colors text-sm">
            <Plus className="h-4 w-4" />
            Add Your First Lead
          </button>
          <p className="text-xs text-gray-400 mt-4">Full lead management coming in the next update</p>
        </div>
      </main>
    </div>
  );
}
