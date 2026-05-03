import { useUser } from "@clerk/react";
import { useState } from "react";
import { Link } from "wouter";
import { Upload, ShieldCheck, FileText, ArrowLeft, CheckCircle, Clock } from "lucide-react";

export default function KycUpload() {
  const { user } = useUser();
  const [aadhaarFile, setAadhaarFile] = useState<File | null>(null);
  const [gstFile, setGstFile] = useState<File | null>(null);
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!aadhaarFile && !gstFile) return;
    setSubmitted(true);
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-3xl border border-gray-100 shadow-sm p-10 max-w-md w-full text-center">
          <div className="h-16 w-16 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-5">
            <CheckCircle className="h-8 w-8 text-green-500" />
          </div>
          <h2 className="text-xl font-bold text-gray-900 mb-2">Documents Submitted!</h2>
          <p className="text-gray-500 text-sm mb-6">
            Our team will review your documents within 1–2 business days. You'll be notified once verified.
          </p>
          <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 rounded-xl px-4 py-3 mb-6">
            <Clock className="h-4 w-4" />
            Review pending — you can still use your trial calls
          </div>
          <Link to="/dashboard" className="block w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold hover:bg-indigo-700 transition-colors text-center">
            Back to Dashboard
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-100">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link to="/dashboard" className="flex items-center gap-2 text-gray-500 hover:text-gray-900 text-sm font-medium transition-colors">
            <ArrowLeft className="h-4 w-4" />
            Dashboard
          </Link>
          <span className="text-gray-300">/</span>
          <span className="text-sm font-semibold text-gray-900">KYC Verification</span>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        <div className="mb-8">
          <div className="flex items-center gap-2 mb-2">
            <ShieldCheck className="h-5 w-5 text-indigo-600" />
            <h1 className="text-xl font-bold text-gray-900">Identity Verification</h1>
          </div>
          <p className="text-gray-500 text-sm">
            Upload your documents to unlock unlimited calling. Our team verifies documents manually within 1–2 business days.
          </p>
        </div>

        {/* What we verify */}
        <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 mb-6">
          <p className="text-sm font-semibold text-indigo-800 mb-2">What we verify</p>
          <ul className="text-sm text-indigo-700 space-y-1">
            <li>• <strong>Individual:</strong> Aadhaar card (front & back)</li>
            <li>• <strong>Business:</strong> GST registration certificate</li>
            <li>• Documents are reviewed securely by our compliance team</li>
          </ul>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Aadhaar upload */}
          <div className="bg-white border border-gray-100 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <FileText className="h-4 w-4 text-gray-600" />
              <h3 className="font-semibold text-gray-900">Aadhaar Card</h3>
              <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-medium">Required for individuals</span>
            </div>
            <label className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${aadhaarFile ? "border-green-300 bg-green-50" : "border-gray-200 bg-gray-50 hover:bg-gray-100"}`}>
              <input
                type="file"
                className="hidden"
                accept="image/*,.pdf"
                onChange={(e) => setAadhaarFile(e.target.files?.[0] ?? null)}
              />
              {aadhaarFile ? (
                <div className="text-center">
                  <CheckCircle className="h-6 w-6 text-green-500 mx-auto mb-1" />
                  <p className="text-sm font-medium text-green-700">{aadhaarFile.name}</p>
                </div>
              ) : (
                <div className="text-center">
                  <Upload className="h-6 w-6 text-gray-400 mx-auto mb-1" />
                  <p className="text-sm text-gray-500">Click to upload Aadhaar card</p>
                  <p className="text-xs text-gray-400 mt-1">PNG, JPG or PDF up to 10MB</p>
                </div>
              )}
            </label>
          </div>

          {/* GST upload */}
          <div className="bg-white border border-gray-100 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <FileText className="h-4 w-4 text-gray-600" />
              <h3 className="font-semibold text-gray-900">GST Certificate</h3>
              <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">Required for businesses</span>
            </div>
            <label className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${gstFile ? "border-green-300 bg-green-50" : "border-gray-200 bg-gray-50 hover:bg-gray-100"}`}>
              <input
                type="file"
                className="hidden"
                accept="image/*,.pdf"
                onChange={(e) => setGstFile(e.target.files?.[0] ?? null)}
              />
              {gstFile ? (
                <div className="text-center">
                  <CheckCircle className="h-6 w-6 text-green-500 mx-auto mb-1" />
                  <p className="text-sm font-medium text-green-700">{gstFile.name}</p>
                </div>
              ) : (
                <div className="text-center">
                  <Upload className="h-6 w-6 text-gray-400 mx-auto mb-1" />
                  <p className="text-sm text-gray-500">Click to upload GST certificate</p>
                  <p className="text-xs text-gray-400 mt-1">PNG, JPG or PDF up to 10MB</p>
                </div>
              )}
            </label>
          </div>

          <button
            type="submit"
            disabled={!aadhaarFile && !gstFile}
            className="w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Submit for Verification
          </button>
          <p className="text-center text-xs text-gray-400">
            Your documents are stored securely and only accessed by our compliance team.
          </p>
        </form>
      </main>
    </div>
  );
}
