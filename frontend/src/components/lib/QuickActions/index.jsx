import { useTranslation } from "react-i18next";
import useUser from "@/hooks/useUser";

/**
 * Quick action buttons for home and empty workspace states.
 * @param {Object} props
 * @param {boolean} props.hasAvailableWorkspace - Whether the user has a workspace they can use
 * @param {Function} props.onCreateAgent - Handler for "Create an Agent" action
 * @param {Function} props.onEditWorkspace - Handler for "Edit Workspace" action
 * @param {Function} props.onUploadDocument - Handler for "Upload a Document" action
 */
export default function QuickActions({
  hasAvailableWorkspace,
  onCreateAgent,
  onEditWorkspace,
  onUploadDocument,
}) {
  const { t } = useTranslation();
  const { user } = useUser();

  return (
    <div className="flex flex-wrap justify-center gap-2 mt-6">
      <QuickActionButton
        label={t("main-page.quickActions.createAgent")}
        onClick={onCreateAgent}
        show={!user || ["admin"].includes(user?.role)}
      />
      <QuickActionButton
        label={t("main-page.quickActions.editWorkspace")}
        onClick={onEditWorkspace}
        show={
          hasAvailableWorkspace &&
          (!user || ["admin", "manager"].includes(user?.role))
        }
      />
      <QuickActionButton
        label={t("main-page.quickActions.uploadDocument")}
        onClick={onUploadDocument}
        show={!user || ["admin", "manager"].includes(user?.role)}
      />
    </div>
  );
}

function QuickActionButton({ label, onClick, show = true }) {
  if (!show) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-5 py-2.5 rounded-full bg-[#1a1726] border border-[rgba(139,92,246,0.25)] text-white/80 text-sm font-normal leading-5 hover:border-[rgba(139,92,246,0.6)] hover:text-white hover:bg-[rgba(139,92,246,0.1)] transition-all duration-200"
    >
      {label}
    </button>
  );
}
