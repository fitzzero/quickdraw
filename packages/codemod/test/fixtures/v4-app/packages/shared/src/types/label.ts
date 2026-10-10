// ============================================================================
// Label Service Types
// ============================================================================

export interface LabelDTO {
  id: string;
  projectId: string;
  name: string;
}

export interface LabelServiceMethods {
  getLabel: {
    payload: { id: string };
    response: LabelDTO | null;
  };
  getLabelName: {
    payload: { id: string };
    response: { name: string } | null;
  };
  renameLabel: {
    payload: { labelId?: string; name: string };
    response: LabelDTO;
  };
  listLabels: {
    payload: { projectId: string };
    response: LabelDTO[];
  };
  deleteAllLabels: {
    payload: { projectId: string };
    response: { count: number };
  };
}
