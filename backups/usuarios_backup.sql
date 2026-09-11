--
-- PostgreSQL database dump
--

\restrict ig7P0MjN2fnh9bBKg92wuyzDXo45mNQr2xo45hnQyqA0rXmeUzeKoTuQJsPO3Ib

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
-- Data for Name: usuarios; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.usuarios (id, nombre, email, password, legajo, puesto, rol, activo, creado_en, departamento, recoff_adeudado) FROM stdin;
2	carlos pasante	carlos@hilton.com	$2a$10$ShcZT9jZIt4OPg4A82/CHe1h0z0S87ZmkFqC9XDX7ngEGfcnWE1LC	30082165	Chef	empleado	0	2026-06-09 14:50:58.356341	\N	0
3	carolina pasante	carolina@hilton.com	$2a$10$GxkyG/uO74uQtzwjr3gUaeyZLJguG0IDHOFOJaY0ALf6yG49Ez/Nu	30082165	Chef	empleado	0	2026-06-09 14:51:25.3547	\N	0
4	Marina	hola@gmail.com	$2a$10$.RHQRjb2CXJw3wy7a3.jYuUXWP1gNBIXB.ELgWmoQIuqp9GFNwINO	300896	Ayudante de cocina	empleado	0	2026-06-12 13:16:14.268763	\N	0
6	Usuario Demo AyB	test1@hilton.com	$2b$12$IZ0h6BkqdztS4Skw7gK3K.UPBBx0lJYVkIlT8mS7dWGC.tKnpvtV2	\N	Cocinero	empleado	0	2026-06-19 16:39:18.847228	ayb	0
5	Usuario Demo Compras	test@hilton.com	$2b$12$IZ0h6BkqdztS4Skw7gK3K.UPBBx0lJYVkIlT8mS7dWGC.tKnpvtV2	\N	Cocinero	empleado	0	2026-06-19 16:39:18.847228	compras	0
7	Usuario Demo Finanzas	test2@hilton.com	$2b$12$IZ0h6BkqdztS4Skw7gK3K.UPBBx0lJYVkIlT8mS7dWGC.tKnpvtV2	\N	Cocinero	empleado	0	2026-06-19 16:39:18.847228	finanzas	0
1	Administrador	admin@hilton.com	$2a$10$hG9KjUDQvZgi75AWPJJFWeBX/vEBgmtN64Kofkls.dS9jHBM8Ze0O	\N	Administrativo	admin	1	2026-06-08 15:03:39.790077	cocina	0
26	LIDIA ESCOBAR	\N	$2a$10$xNXxDWWGAu/WtOjIqUJ8eeGcuQyzxlUlnszVo54qjq9x3mateu7yu	\N	Encargado de cocina	supervisor	1	2026-06-24 14:43:52.480041	Supervisores	0
23	JUAN PABLO GONZALEZ	\N	$2a$10$2UqXhj7hlWAwDjDTz8c7k.TWGr/irMLxgRGWLK1FN8KBLrfo5UoVm	\N	Encargado de cocina	supervisor	1	2026-06-24 14:43:11.86245	Supervisores	0
24	PABLO DELUCHI	\N	$2a$10$f/i4MS6W5X2xLVufvwTFRuKlLgOWr4OHnouYBWfaMDXJsx2M/gL7a	\N	Encargado de cocina	supervisor	1	2026-06-24 14:43:28.311972	Supervisores	0
27	PAULA SAUCEDO	\N	$2a$10$1hm1drb14KOAOlluPetMaOWD9jY3XjUsG4Thg9uo3MelxKiJJT5uO	\N	Encargado de cocina	supervisor	1	2026-06-24 14:44:13.884452	Supervisores	0
28	FRANCISCO EYHERABIDE	\N	$2a$10$WNdqPlP.HanlfOLD8Nn8PeTGtIxQ8.AS0qpsXQ.NWeLUB.KsF.qeu	\N	Encargado de cocina	supervisor	1	2026-06-24 14:44:53.686522	Supervisores	0
31	OSCAR COLZERA	\N	$2a$10$ZgEkO08iwMH0qv1OgiQP9elcF.66TCG0heSbnrwcRmxOqa/TQCpP.	\N	Panadero	empleado	1	2026-06-24 14:45:49.895005	Panadería	0
32	HUALDO SOTO	\N	$2a$10$ip11C6RS7LQOrpQX/Ey0guW52gVMxH7giNIsjCE5Zlr89LdfDN2xC	\N	Panadero	empleado	1	2026-06-24 14:46:12.198095	Panadería	0
33	GABRIEL CAMPOS	\N	$2a$10$ee6aYJ2IxVghkf9vy5SUL.6nKAcVx1QyezI4eFW0EViLUpTdYSblu	\N	Panadero	empleado	1	2026-06-24 14:46:31.496852	Panadería	0
34	LEANDRO LEDESMA	\N	$2a$10$3rJBW.IivOrBw8shFIX.teBmzPLBy3iUwcbAZ9FGQx5INKxmCx8ci	\N	Panadero	empleado	1	2026-06-24 14:46:57.088505	Panadería	0
35	SABRINA RODRIGUEZ	\N	$2a$10$vPQVEhna0hpdJC/51hVATOFK0Pvf5TcH7h7XfR0nvcNqz6mbBYyxC	\N	Pastelero	empleado	1	2026-06-24 14:47:27.059967	Pastelería AM	0
36	MARTINA VALLERINO	\N	$2a$10$VKJYQuYRLKc2u.B2svauZe9rbO/57As6iVmWrU0HUR5DDexL1USva	\N	Pastelero	empleado	1	2026-06-24 14:48:19.807903	Pastelería AM	0
37	FELIPE TARRAMASCO	\N	$2a$10$nRvTXuJcHq23MKYGCkbIv.ckqzI.30mitaVjDlGbeWCZwo4XFHACa	\N	Pastelero	empleado	1	2026-06-24 14:48:41.52461	Pastelería AM	0
38	GIANLUCA TERRANOVA	\N	$2a$10$0uU94UIg7PCBv6/zps/PieYlDKDksuH49SHbzLCdanBu7ECzfXmG6	\N	Pastelero	empleado	1	2026-06-24 14:49:03.227256	Pastelería AM	0
39	RONEL MORALES	\N	$2a$10$Q/Qe7URB/ECpVIr7Gz6YU.Aosn.Jx8YjunYhzhsaf.FMrMOLqTpvG	\N	Pastelero	empleado	1	2026-06-24 14:49:45.31957	Pastelería PM	0
40	MACARENA ARAUJO	\N	$2a$10$6pg.z9v0Azk48Jzlh6RakuOl1GIoy7aj0bSZyu6Q4S1P0J5DgGUhC	\N	Pastelero	empleado	1	2026-06-24 14:49:54.968306	Pastelería PM	0
41	LUIS NADAL	\N	$2a$10$EqI2WU0dkvmleVxtsA9OzuL1KoVk3xGFoixCgbURZQh3yWT2S4IaC	\N	Pastelero	empleado	1	2026-06-24 14:50:03.228274	Pastelería PM	0
42	MARIANO MARTINI	\N	$2a$10$N5.Em3pZb59rO8hCTG4G2eTKQgY0bI8tqYxXdBh09euXXW6TUXfb2	\N	Cocinero	empleado	1	2026-06-24 14:50:11.218728	Faro AM	0
44	ROMINA SOSA	\N	$2a$10$O5gLQd9nCfH5WvmZ7BT.L.6gi4VR1Xyls5nZ4EsIEe43mdXwxi2I2	\N	Cocinero	empleado	1	2026-06-24 14:50:36.736088	Faro AM	0
45	LUCIO ESPINDOLA	\N	$2a$10$fTqv1ZRklmqy8.4t4q/d5OLSbA3g9oMjIMo00SyqcGdU6T9Ri2H1u	\N	Cocinero	empleado	1	2026-06-24 14:50:48.430951	Faro AM	0
46	MARTIN RISARI	\N	$2a$10$9mrmlykzRlD2MYyqeQPl5uIqj8RIWjEKXqmMwpBTpby6vXqszmrFS	\N	Cocinero	empleado	1	2026-06-24 14:50:59.94184	Faro AM	0
47	ARIEL VAZQUEZ	\N	$2a$10$N9Obr73m5jzBjgGJFINoBev4x6OAgGPsb6SRt/U9HqJA8fOLmLrQu	\N	Cocinero	empleado	1	2026-06-24 14:51:07.983974	Faro AM	0
48	MATIAS ALVAREZ	\N	$2a$10$gQEcguzcix2LvgE8i9SkWuAqMS4H6c70KseU4q02FqcaRijSmwL6G	\N	Cocinero	empleado	1	2026-06-24 14:51:14.870125	Faro AM	0
49	DANIEL CORREA	\N	$2a$10$OSO2EMJHe/eQ2P6GF94KEeCeLzhGy4SkyZAhNrhYQ3Z9bE0YuLQQ6	\N	Cocinero	empleado	1	2026-06-24 14:51:23.327754	Faro PM	0
50	FACUNDO REYNA	\N	$2a$10$IsY7CLhO5FMd7x.OMJ6vcekTXWlI./qksr5sXslq2WizRoFkqW3Ri	\N	Cocinero	empleado	1	2026-06-24 14:51:30.688492	Faro PM	0
51	TOMAS MINELLA	\N	$2a$10$tjOVZSC9lbeYWsm2DQqnsegXyAKv0F.i6tASgFb6XoGXqHfcpuKhW	\N	Cocinero	empleado	1	2026-06-24 14:51:40.071245	Faro PM	0
52	JUAN LOPEZ	\N	$2a$10$HZ/0Vlg9zMvPNjO3.Vryu.le1jkcYaUmv3yc5fSYkGQkZhWT8EGeS	\N	Cocinero	empleado	1	2026-06-24 14:51:47.267281	Faro PM	0
8	FELIPE DI LORENZO	\N	$2a$10$gyfKss6rJf4bDJlh.C/wzOxKQmDMbEdCMpZ.AfzAaZNWsLIIO3CA6	\N	Cocinero	empleado	1	2026-06-24 13:43:55.979724	Nocturno	0
20	SABRINA FERNANDEZ	\N	$2a$10$FYWiuG53k1HXUEij4UZrduokTbPnZ/sXq8Mz/3xoH38Llykqc7pm6	\N	Cocinero	empleado	1	2026-06-24 14:41:20.48884	Farolito	0
22	BAUTISTA SANCHEZ	\N	$2a$10$8z5LnJB5cNmeZ75hwUBk.e5Yrz7FCf7Frq9CzJt4E1uywFgls0ocW	\N	Cocinero	empleado	1	2026-06-24 14:42:05.36465	Cocina I+D	0
21	MATIAS GOMEZ	\N	$2a$10$PU0f9UJdcCmEBWt3Ol2aCePoZhEUUfTOCDuao7rV7ED6oKJSt3JKe	\N	Cocinero	empleado	1	2026-06-24 14:41:34.33443	Farolito	0
13	GISELA FORNARA	\N	$2a$10$cNLhhlvBEHBYIQk02GGslejCO/ZP4nd7UzJnagybRShIMcsobpml2	\N	Cocinero	empleado	1	2026-06-24 14:34:01.009606	BQTs Fríos	0
18	GIULIANO MILILLO	\N	$2a$10$bgRJeeuExh0CYbCCqrxc8enIZi3p/4wn3r1v94y5l0XIJa2kEZHlu	\N	Cocinero	empleado	0	2026-06-24 14:38:59.804038	BQTs Calientes	0
30	ARIEL ARRUA	\N	$2a$10$I8fos0j5y4Nb0ksmcYurx.U2h.ocfvLo.pVe7z/.NjJmJZkdavL9y	\N	Ayudante de cocina	empleado	1	2026-06-24 14:45:28.443542	Comis de Recepción	0
17	PABLO BURGOS	\N	$2a$10$WjUQfIfsM.BRs7a1bFaHY.wAbH3vYSnjtwWHqbsrITJZt/JEiCc16	\N	Cocinero	empleado	1	2026-06-24 14:35:13.614766	Farolito	0
16	HOWIE GONZALEZ	\N	$2a$10$T9Vogt.f/mKK8bgKFQPxMOYScX9q1fI1fVLtKoiAIbsdUxosY4pYa	\N	Cocinero	empleado	1	2026-06-24 14:34:46.861483	BQTs Calientes	6
29	DANIEL INCARBONE	\N	$2a$10$jZayU/SN0ZpIhoxUHScUvuHqonWy0Wu9nP4we5BeXeyEaDODMXc..	\N	Encargado de cocina	supervisor	1	2026-06-24 14:45:14.698508	Supervisores	5
25	ALAN MAMANI	\N	$2a$10$Bg5aU3uIRomxpUv6VpkRdOtUaxJJf07qPTXn5Dtvp4yZktNZGYDDG	\N	Encargado de cocina	supervisor	1	2026-06-24 14:43:36.493243	Supervisores	8
43	SEBASTIAN RISOTTO	\N	$2a$10$KiUUOGIBx2BRkduXJTqlzOjF8uk7FingEF1r2LsqQu1BuqrrX35lu	\N	Cocinero	empleado	1	2026-06-24 14:50:27.976201	Faro AM	0
19	JIMENA SANTILLAN	\N	$2a$10$0PEbHBQ1AWMJA.hVMyLZpOwCUWIB.rQgFKqXADSahakw0E47VuG2a	\N	Cocinero	empleado	1	2026-06-24 14:40:52.530723	Farolito	0
14	DANIELA RIOS	\N	$2a$10$ayys.8RaihD8Tu4HG07lv.2.jCXw7hF3ctolYHC0vgWQ9t7mWL3d.	\N	Cocinero	empleado	1	2026-06-24 14:34:11.786711	BQTs Fríos	0
15	BRANDON AREVALO	\N	$2a$10$HqOTqhpX83FUmzfMpuEIjexJabWbpta3aAAY0ZVxHESS19rQgbPoy	\N	Cocinero	empleado	1	2026-06-24 14:34:26.74555	BQTs Fríos	0
12	FACUNDO RAGONA	\N	$2a$10$vCBCqO9sfRsMaLxIgkEnr.TWfpcwDqYyqLf2uW6x4e.9dMN/7xm7e	\N	Cocinero	empleado	1	2026-06-24 14:33:01.307703	BQTs Fríos	0
58	Catalina	cata@hilton.com	$2a$12$hoCPa2RVL1ldhwjocUf5Iu2u9GQrG7DawyScdECt/XM22RECp1FfS	\N	Cocinero	empleado	1	2026-07-03 15:51:08.849401	cocina	0
59	ADMIN2	admin2@hilton.com	$2a$12$I5ziEDVYyTTYC0MbZZPhEO86W8rRd0/uUuWn9ZLXmjR7FomG8nr5C	\N	Cocinero	empleado	1	2026-08-18 13:52:02.551438	ayb	0
\.


--
-- PostgreSQL database dump complete
--

\unrestrict ig7P0MjN2fnh9bBKg92wuyzDXo45mNQr2xo45hnQyqA0rXmeUzeKoTuQJsPO3Ib

