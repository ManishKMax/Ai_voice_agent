import { useUser, useAuth } from "@clerk/react";
import { useState, useRef } from "react";
import { Link, useLocation } from "wouter";
import { Upload, ShieldCheck, FileText, ArrowLeft, CheckCircle, Clock, Loader2, AlertCircle, X } from "lucide-react";
import { useUpload } from "@workspace/object-storage-web";
import { portalFetch } from "@/lib/portalFetch";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

interface UploadedDoc {
  documentType: "aadhaar" | "gst";
  objectPath: string;
  fileName: string;
}

interface FileState {
  file: File | null;
  uploading: boolean;
  done: boolean;
  error: string | null;
  objectPath: string | null;
}

function createFileState(): FileState {
  return { file: null, uploading: false, done: false, error: null, objectPath: null };
}

export default function KycUpload() {
  const [, setLocation] = useLocation();
  const { getToken } = useAuth();
  const [aadhaar, setAadhaar] = useState<FileState>(createFileState());
  const [gst, setGst] = useState<FileState>(createFileState());
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const aadhaarInputRef = useRef<HTMLInputElement>(null);
  const gstInputRef = useRef<HTMLInputElement>(null);

  const { uploadFile: uploadFileHook } = useUpload({
    basePath: `/api/storage`,
  });

  async function handleFileSelect(
    file: File,
    docType: "aadhaar" | "gst",
    setState: React.Dispatch<React.SetStateAction<FileState>>,
  ) {
    setState({ file, uploading: true, done: false, error: null, objectPath: null });

    try {
      const result = await uploadFileHook(file);
      if (!result) throw new Error("Upload failed — please try again");
      setState({ file, uploading: false, done: true, error: null, objectPath: result.objectPath });
    } catch (err) {
      setState({ file, uploading: false, done: false, error: (err as Error).message, objectPath: null });
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);

    const documents: UploadedDoc[] = [];
    if (aadhaar.done && aadhaar.objectPath && aadhaar.file) {
      documents.push({ documentType: "aadhaar", objectPath: aadhaar.objectPath, fileName: aadhaar.file.name });
    }
    if (gst.done && gst.objectPath && gst.file) {
      documents.push({ documentType: "gst", objectPath: gst.objectPath, fileName: gst.file.name });
    }

    if (documents.length === 0) {
      setSubmitError("Please upload at least one document before submitting.");
      return;
    }

    setSubmitting(true);
    try {
      const token = await getToken();
      await portalFetch("/api/portal/kyc/submit", token, {
        method: "POST",
        body: JSON.stringify({ documents }),
      });
      setSubmitted(true);
    } catch (err) {
      setSubmitError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
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
            <Clock className="h-4 w-4 flex-shrink-0" />
            Review pending — you can still use your trial calls
          </div>
          <Link
            to="/dashboard"
            className="block w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold hover:bg-indigo-700 transition-colors text-center"
          >
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
          <Link
            to="/dashboard"
            className="flex items-center gap-2 text-gray-500 hover:text-gray-900 text-sm font-medium transition-colors"
          >
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

        <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 mb-6">
          <p className="text-sm font-semibold text-indigo-800 mb-2">What we verify</p>
          <ul className="text-sm text-indigo-700 space-y-1">
            <li>• <strong>Individual:</strong> Aadhaar card (front &amp; back)</li>
            <li>• <strong>Business:</strong> GST registration certificate</li>
            <li>• Documents are reviewed securely by our compliance team</li>
          </ul>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <FileUploadCard
            label="Aadhaar Card"
            badge="Required for individuals"
            badgeColor="bg-amber-100 text-amber-700"
            state={aadhaar}
            inputRef={aadhaarInputRef}
            onFileSelect={(file) => handleFileSelect(file, "aadhaar", setAadhaar)}
            onClear={() => setAadhaar(createFileState())}
          />

          <FileUploadCard
            label="GST Certificate"
            badge="Required for businesses"
            badgeColor="bg-blue-100 text-blue-700"
            state={gst}
            inputRef={gstInputRef}
            onFileSelect={(file) => handleFileSelect(file, "gst", setGst)}
            onClear={() => setGst(createFileState())}
          />

          {submitError && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {submitError}
            </div>
          )}

          <button
            type="submit"
            disabled={(!aadhaar.done && !gst.done) || aadhaar.uploading || gst.uploading || submitting}
            className="w-full bg-indigo-600 text-white py-3 rounded-xl font-semibold hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {submitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Submitting…
              </>
            ) : (
              "Submit for Verification"
            )}
          </button>
          <p className="text-center text-xs text-gray-400">
            Your documents are stored securely and only accessed by our compliance team.
          </p>
        </form>
      </main>
    </div>
  );
}

function FileUploadCard({
  label,
  badge,
  badgeColor,
  state,
  inputRef,
  onFileSelect,
  onClear,
}: {
  label: string;
  badge: string;
  badgeColor: string;
  state: FileState;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onFileSelect: (file: File) => void;
  onClear: () => void;
}) {
  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) onFileSelect(file);
    e.target.value = "";
  }

  const isIdle = !state.file;
  const isUploading = state.uploading;
  const isDone = state.done;
  const hasError = !!state.error;

  const borderClass = isDone
    ? "border-green-300 bg-green-50"
    : hasError
    ? "border-red-300 bg-red-50"
    : "border-gray-200 bg-gray-50 hover:bg-gray-100";

  return (
    <div className="bg-white border border-gray-100 rounded-2xl p-6">
      <div className="flex items-center gap-2 mb-4">
        <FileText className="h-4 w-4 text-gray-600" />
        <h3 className="font-semibold text-gray-900">{label}</h3>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${badgeColor}`}>{badge}</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept="image/*,.pdf"
        onChange={handleChange}
      />

      {isIdle && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className={`flex flex-col items-center justify-center w-full h-32 border-2 border-dashed rounded-xl cursor-pointer transition-colors ${borderClass}`}
        >
          <Upload className="h-6 w-6 text-gray-400 mb-1" />
          <p className="text-sm text-gray-500">Click to upload {label}</p>
          <p className="text-xs text-gray-400 mt-1">PNG, JPG or PDF · max 10 MB</p>
        </button>
      )}

      {isUploading && (
        <div className="flex flex-col items-center justify-center w-full h-32 border-2 border-dashed border-indigo-200 rounded-xl bg-indigo-50">
          <Loader2 className="h-6 w-6 text-indigo-500 animate-spin mb-2" />
          <p className="text-sm text-indigo-600 font-medium">Uploading…</p>
          <p className="text-xs text-indigo-400 mt-1">{state.file?.name}</p>
        </div>
      )}

      {isDone && (
        <div className="flex items-center justify-between w-full px-4 py-3 border-2 border-green-300 rounded-xl bg-green-50">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-5 w-5 text-green-500 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-green-700">{state.file?.name}</p>
              <p className="text-xs text-green-500">Uploaded successfully</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClear}
            className="text-gray-400 hover:text-gray-600 p-1 rounded transition-colors"
            title="Remove file"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {hasError && (
        <div className="w-full">
          <div className="flex items-center gap-2 px-4 py-3 border-2 border-red-300 rounded-xl bg-red-50 mb-2">
            <AlertCircle className="h-5 w-5 text-red-500 flex-shrink-0" />
            <p className="text-sm text-red-600">{state.error}</p>
          </div>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-sm text-indigo-600 font-medium hover:text-indigo-700 transition-colors"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
