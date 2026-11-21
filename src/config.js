/**
 * Supabase connection. Both values are safe to publish: the key is the
 * *publishable* (or legacy "anon") key, and the database only lets it call the
 * functions in supabase/schema.sql. Never put a secret / service_role key here.
 *
 * Leave these empty to run in demo mode: everything is stored in this browser
 * only, which is handy for trying the app out or testing it alone.
 */
export const SUPABASE_URL = "https://tfulhdmwhgyvkazycuhx.supabase.co";
export const SUPABASE_KEY = "sb_publishable_HdubQ0mJH63I3eGEi7fcOg_3nH3gXqH";
