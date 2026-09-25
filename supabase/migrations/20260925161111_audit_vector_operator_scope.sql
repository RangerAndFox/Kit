-- Resolve pgvector operators in the actual provider extension schema.
ALTER FUNCTION public.match_documents(extensions.vector, integer, uuid, uuid, text[]) SET search_path = public, extensions;
