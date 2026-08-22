-- Separate databases for separate owners.
--
-- LiteLLM manages its own schema with Prisma, and its startup migration will drop tables it
-- does not recognise. Pointed at the application database it deletes the entire KNA schema —
-- observed, not theorised: it happened here, and in a shared staging environment it would have
-- destroyed the corpus with no warning and no error.
--
-- A third-party service that runs schema migrations gets its own database. Always.
CREATE DATABASE kna_litellm OWNER kna;

COMMENT ON DATABASE kna_litellm IS
  'LiteLLM proxy state. Managed by LiteLLM Prisma migrations — never point application code here.';
