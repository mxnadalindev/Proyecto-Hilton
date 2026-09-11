--
-- PostgreSQL database dump
--

\restrict UHYZRUUKGPJVRbksmncVqXCoptUfSLu8PAZWFzNu5pSXxOdFweVP6BMxVlgMQTd

-- Dumped from database version 18.4
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: horarios_semanales; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.horarios_semanales (id, usuario_id, fecha, valor, creado_en, sector_dia) FROM stdin;
413	16	2026-08-10	8	2026-08-14 16:20:35.5875	\N
414	16	2026-08-11	8	2026-08-14 16:20:35.603526	\N
415	16	2026-08-12	LIBRE	2026-08-14 16:20:35.604115	\N
416	16	2026-08-13	LICENCIA	2026-08-14 16:20:35.604588	\N
417	16	2026-08-14	RECOFF	2026-08-14 16:20:35.60505	\N
418	16	2026-08-15	RECOFF	2026-08-14 16:20:35.605516	\N
419	16	2026-08-16	RECOFF	2026-08-14 16:20:35.605931	\N
420	25	2026-08-10	RECOFF	2026-08-14 16:55:28.158835	\N
421	25	2026-08-11	RECOFF	2026-08-14 16:55:28.165167	\N
422	25	2026-08-12	RECOFF	2026-08-14 16:55:28.165932	\N
11	25	2026-05-25	8PM	2026-06-26 14:45:35.296941	\N
423	25	2026-08-13	RECOFF	2026-08-14 16:55:28.166533	\N
424	25	2026-08-14	CUMPLE	2026-08-14 16:55:28.16703	\N
425	25	2026-08-15	8	2026-08-14 16:55:28.167547	\N
426	25	2026-08-16	8	2026-08-14 16:55:28.168065	\N
427	16	2026-08-17	OFF	2026-08-18 16:04:01.30085	\N
428	16	2026-08-18	OFF	2026-08-18 16:04:01.323721	\N
429	16	2026-08-19	CUMPLE	2026-08-18 16:04:01.324589	\N
430	16	2026-08-20	7	2026-08-18 16:04:01.325098	Faro AM
431	16	2026-08-21	7	2026-08-18 16:04:01.325598	\N
432	16	2026-08-22	7	2026-08-18 16:04:01.326041	\N
433	16	2026-08-23	RECOFF	2026-08-18 16:04:01.326468	\N
\.


--
-- PostgreSQL database dump complete
--

\unrestrict UHYZRUUKGPJVRbksmncVqXCoptUfSLu8PAZWFzNu5pSXxOdFweVP6BMxVlgMQTd

