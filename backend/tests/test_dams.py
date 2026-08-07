"""Global Dam Watch's attribute table -> dam records.

Every row below is copied verbatim out of GDW_barriers_v1_0.txt, header
included, so the 71-column layout is exercised as GDW actually ships it rather
than as a hand-written fixture imagines it. Three things about that file are
load-bearing and none of them are obvious from the column names:

  - No-data is written as -99, not as an empty cell, in every numeric column.
    Take the cells at face value and the popup says "built in -99".
  - Except in the coordinates, where -99 is a longitude. Row 33577 sits at
    -99.331, which a blanket sentinel rule would delete.
  - GRAND_ID and HYLAK_ID use 0 for "no link", a third convention again.

The zip is not fetched here. The 70 MB archive is a download, not a fixture;
what is tested is the CSV inside it, plus a two-kilobyte zip built on the fly to
pin the member lookup and the decode.
"""

import csv
import io
import zipfile

from backend.sources import dams

HEADER = (
    "GDW_ID,RES_NAME,DAM_NAME,ALT_NAME,DAM_TYPE,LAKE_CTRL,RIVER,ALT_RIVER,MAIN_BASIN,SUB_BASIN,"
    "COUNTRY,SEC_CNTRY,ADMIN_UNIT,SEC_ADMIN,NEAR_CITY,ALT_CITY,YEAR_DAM,PRE_YEAR,YEAR_SRC,ALT_YEAR,"
    "REM_YEAR,TIMELINE,YEAR_TXT,DAM_HGT_M,ALT_HGT_M,DAM_LEN_M,ALT_LEN_M,AREA_SKM,AREA_POLY,AREA_REP,"
    "AREA_MAX,AREA_MIN,CAP_MCM,CAP_MAX,CAP_REP,CAP_MIN,DEPTH_M,DIS_AVG_LS,DOR_PC,ELEV_MASL,"
    "CATCH_SKM,CATCH_REP,POWER_MW,DATA_INFO,USE_IRRI,USE_ELEC,USE_SUPP,USE_FCON,USE_RECR,USE_NAVI,"
    "USE_FISH,USE_PCON,USE_LIVE,USE_OTHR,MAIN_USE,MULTI_DAMS,COMMENTS,URL,QUALITY,EDITOR,"
    "LONG_RIV,LAT_RIV,LONG_DAM,LAT_DAM,ORIG_SRC,POLY_SRC,GRAND_ID,HYRIV_ID,INSTREAM,HYLAK_ID,HYBAS_L12"
)

# Kakhovka. Named, GRanD-derived, 18,180 Mm3 behind it, and -- like 85% of the
# file -- placed by the river snap because GDW publishes no dam coordinate.
KAKHOVKA = (
    "54,Kakhovskoye,Kakhovskaya,Kakhovka Reservoir,Dam,,Dniepr,,,,Ukraine,,Kherson,Zaporizhia,"
    "Kakhovka,,1955,-99,GRanD,-99,-99,,Built 1955,37,-99,437,-99,2098.163000000000011,"
    "2098.163000000000011,2155.000000000000000,-99.000000000000000,1600.000000000000000,"
    "18180.000000000000000,-99.000000000000000,18180.000000000000000,-99.000000000000000,8.6999998,"
    "1499857,38.4000015,11,487441,-99,-99.000000000000000,,Sec,Main,Sec,,,Sec,,,,,Hydroelectricity,"
    ",,,3: Fair,McGill-BL,33.372917000000029,46.781250000000057,,,GRanD,SWBD,4376,20460790,Instream,"
    "129,2120513270.000000000000000"
)

# One of the 242 rows in the whole file (0.6%) that carries POWER_MW, and one of
# the 1,229 with a URL. Also the only non-ASCII row here ("Mehedinți"), which is
# what makes the decode in _read_member observable.
IRON_GATE = (
    "285,,Iron Gate 1,Portile de Fier I; Djerdap I,Dam,,Danube,Dunarea; Dunav,,,Romania,Serbia,"
    "Mehedinți,Borski,Drobeta Turnu Severin,,1972,-99,GRanD,1964,-99,,Built 1972,60,-99,1278,-99,"
    "118.835999999999999,118.835999999999999,107.000000000000000,-99.000000000000000,"
    "-99.000000000000000,2550.000000000000000,2550.000000000000000,2100.000000000000000,"
    "-99.000000000000000,21.5000000,5506185,1.5000000,54,560682,-99,2200.000000000000000,,,Main,,,,"
    "Sec,,,,,Hydroelectricity,,Very large hydropower station (installed capacity 2200 MW) at border "
    "of Romania and Serbia; alternative administrative unit: Serbia Borski,"
    "http://en.wikipedia.org/wiki/Iron_Gate_I_Hydroelectric_Power_Station,2: Good,McGill-BL,"
    "22.530866000000060,44.673332000000073,,,GRanD,McGill,3880,20511040,Instream,1293,"
    "2120559640.000000000000000"
)

# One of only 31 rows GDW grades "1: Verified".
DAU_TIENG = (
    "372,,Dau Tieng,,Dam,,Saigon,,Dong Nai,,Vietnam,,Bình Dương,Tây Ninh,"
    "Ho Chi Minh City,,1985,-99,GRanD,-99,-99,,Built 1985,28,-99,1100,-99,186.699000000000012,"
    "186.699000000000012,270.000000000000000,-99.000000000000000,-99.000000000000000,"
    "1580.000000000000000,-99.000000000000000,1580.000000000000000,-99.000000000000000,8.5000000,"
    "106360,47.0999985,18,2677,-99,-99.000000000000000,,Main,,Sec,,,,,,,,Irrigation,,,,1: Verified,"
    "McGill-PB,106.344788860000051,11.323937279000063,,,GRanD,SWBD,7396,41376664,Instream,1547,"
    "4121596230.000000000000000"
)

KARAOUN = (
    "4596,,Karaoun,Al Qirawn; Qaroon,Dam,,Litani,,,,Lebanon,,Bekaa,,Aitanit,,1965,-99,GRanD,-99,-99,,"
    "Built 1965,70,-99,1100,-99,5.505000000000000,5.505000000000000,-99.000000000000000,"
    "-99.000000000000000,-99.000000000000000,160.000000000000000,-99.000000000000000,"
    "160.000000000000000,-99.000000000000000,29.1000004,17365,29.2000008,838,1576,-99,"
    "-99.000000000000000,,,,,,,,,,,,,,,,2: Good,McGill-BL,35.689696000000026,33.549227000000030,,,"
    "GRanD,SWBD,4473,20731536,Instream,174944,2121277940.000000000000000"
)

# Unnamed, which is the ordinary case: 2,885 of the 3,555 clipped records have
# neither a dam name nor a reservoir name.
SYRIA_UNNAMED = (
    "9117,,,,Dam,,,,,,Syria,,Quneitra,,,,1992,-99,Estimated,-99,-99,,Built 1992,-99,-99,-99,-99,"
    "2.899000000000000,2.899000000000000,-99.000000000000000,-99.000000000000000,"
    "-99.000000000000000,48.299999999999997,-99.000000000000000,-99.000000000000000,"
    "-99.000000000000000,16.7000008,1327,115.4000015,756,261,-99,-99.000000000000000,"
    "Capacity from statistics - Eq 2,,,,,,,,,,,,,,,3: Fair,McGill-MA,35.918490000000077,"
    "33.027189000000078,,,GOODD,SWBD,0,20741091,Instream,175075,2121282690.000000000000000"
)

# Guangdong, inside the Taiwan Strait box *and* the South China Sea box.
OVERLAP_CHINA = (
    "9715,,,,Dam,,,,,,China,,Guangdong,,,,-99,-99,,-99,-99,,Unknown year,-99,-99,-99,-99,"
    "1.015000000000000,1.015000000000000,-99.000000000000000,-99.000000000000000,"
    "-99.000000000000000,15.900000000000000,-99.000000000000000,-99.000000000000000,"
    "-99.000000000000000,15.6999998,315,160.1000061,32,12,-99,-99.000000000000000,"
    "Capacity from statistics - Eq 2,,,,,,,,,,,,,,,3: Fair,McGill-MA,116.393731000000116,"
    "22.989871000000051,,,GOODD,SWBD,0,41081869,Instream,177581,4120012370.000000000000000"
)

# The worst dam/river disagreement in the file: 91.8 km, and a longitude of
# -99.331 that a naive no-data rule would throw away.
NOTIGI = (
    "33577,Notigi Reservoir,Notigi Control Structure,,Lake Control Dam,Yes,,,,,Canada,,Manitoba,,,,"
    "1974,-99,Other,-99,-99,,Built 1974,-99,-99,-99,-99,697.114000000000033,697.114000000000033,"
    "-99.000000000000000,-99.000000000000000,-99.000000000000000,6970.000000000000000,"
    "-99.000000000000000,6970.000000000000000,-99.000000000000000,10.0000000,16704,1323.0999756,255,"
    "6026,-99,-99.000000000000000,Capacity estimated,,,,,,,,,,,,Yes,Part of Nelson River "
    "Hydroelectric Project; location of Notigi Control Structure (dam) is in the south-west corner "
    "of Notigi Reservoir and raises the level of Southern Indian Lake by about 10 m,"
    "https://heritage.enggeomb.ca/index.php/Churchill_River_Diversion,2: Good,McGill-TX,"
    "-99.049422999999990,56.668189000000041,-99.331192189199996,55.858540437599999,GROD,Other,0,"
    "70050883,Instream,462,7120124010.000000000000000"
)

# Every numeric column is -99 and both cross-reference ids are 0. The emptiest
# shape the file contains, and it still has a coordinate and a country.
MOSCOW_EMPTY = (
    "33652,,,,Dam,,,,,,Russia,,Moscow City,,,,-99,-99,,-99,-99,,Unknown year,-99,-99,-99,-99,"
    "-99.000000000000000,-99.000000000000000,-99.000000000000000,-99.000000000000000,"
    "-99.000000000000000,-99.000000000000000,-99.000000000000000,-99.000000000000000,"
    "-99.000000000000000,-99.0000000,59568,-99.0000000,116,9110,-99,-99.000000000000000,,,,,,,,,,,,"
    ",,,,2: Good,McGill-TX,37.820608266000079,55.618416715000080,37.798526868078966,"
    "55.612468062070882,GROD,No Polygon,0,20240173,Instream,0,2120302790.000000000000000"
)

# Donetsk. One of the 675 clipped records that does carry a published dam
# location, so the preference in _coordinate is exercised inside a theatre.
DONETSK = (
    "33670,,,,Dam,,,,,,Ukraine,,Donets'k,,,,-99,-99,,-99,-99,,Unknown year,-99,-99,-99,-99,"
    "4.928000000000000,4.928000000000000,-99.000000000000000,-99.000000000000000,"
    "-99.000000000000000,84.799999999999997,-99.000000000000000,-99.000000000000000,"
    "-99.000000000000000,17.2000008,16156,16.6000004,59,5307,-99,-99.000000000000000,"
    "Capacity from statistics - Eq 2,,,,,,,,,,,,,,,2: Good,McGill-TX,37.735108000000025,"
    "48.884752000000049,37.707140085200002,48.860621779399999,GROD,SWBD,0,20401835,Instream,167961,"
    "2120457960.000000000000000"
)

ALL_ROWS = (
    KAKHOVKA, IRON_GATE, DAU_TIENG, KARAOUN, SYRIA_UNNAMED,
    OVERLAP_CHINA, NOTIGI, MOSCOW_EMPTY, DONETSK,
)


def parse(*rows, released=None):
    return dams.parse_barriers("\n".join((HEADER,) + (rows or ALL_ROWS)) + "\n", released)


def row_dict(line: str) -> dict:
    """One CSV line as parse_barriers sees it, for the helpers below the parse."""
    return next(csv.DictReader(io.StringIO(HEADER + "\n" + line + "\n")))


def by_id(records) -> dict:
    return {r["id"]: r for r in records}


# --- coordinates ------------------------------------------------------------


def test_the_published_dam_location_is_preferred_over_the_river_snap():
    (record,) = parse(DONETSK)
    assert (record["lat"], record["lon"]) == (48.860621779399999, 37.707140085200002)
    assert record["coord_source"] == "dam"


def test_a_row_with_no_dam_location_falls_back_to_the_river_snap():
    """85% of the file. Kakhovka is one of them."""
    (record,) = parse(KAKHOVKA)
    assert (record["lat"], record["lon"]) == (46.781250000000057, 33.372917000000029)
    assert record["coord_source"] == "river_snap"


def test_the_two_coordinate_pairs_can_disagree_by_ninety_kilometres():
    """Notigi is the file's worst case: the control structure is 92 km from the
    river reach it regulates. Which pair placed the pin has to stay visible --
    that is the whole reason `coord_source` exists rather than one merged
    coordinate.

    It is also the row where GDW's no-data sentinel is a real place: -99.331 is
    a longitude in Manitoba, and a -99 rule applied blindly across the row would
    delete it. The sentinel is only ever applied to the measure columns.
    """
    row = row_dict(NOTIGI)
    lat, lon, source = dams._coordinate(row)
    assert source == "dam"
    assert (lat, lon) == (55.858540437599999, -99.331192189199996)
    # The river snap it was preferred over, ~0.81 degrees of latitude away.
    assert abs(float(row["LAT_RIV"]) - lat) > 0.8


def test_every_record_carries_a_geo_precision():
    """p99 between the two coordinate pairs is 1.3 km: the right structure, not
    necessarily the right abutment of it."""
    assert {r["geo_precision"] for r in parse()} == {"locality"}


# --- theatre clipping -------------------------------------------------------


def test_the_theatre_the_dam_falls_in_travels_with_the_record():
    records = by_id(parse())
    assert records["gdw:54"]["region_key"] == "russia_ukraine"
    assert records["gdw:4596"]["region_key"] == "israel_gaza_lebanon"
    assert records["gdw:372"]["region_key"] == "south_china_sea"


def test_a_dam_outside_every_theatre_is_dropped():
    """41,145 dams globally, 3,555 in the eleven boxes. Notigi is in Manitoba."""
    assert parse(NOTIGI) == []
    assert "gdw:33577" not in by_id(parse())


def test_a_dam_in_two_overlapping_theatres_is_listed_once_under_the_first():
    """The Taiwan Strait box sits inside the South China Sea box. Emitting the
    same dam under both would report more dams than the map draws, which reads
    as a renderer bug rather than as double-counting."""
    records = parse(OVERLAP_CHINA)
    assert len(records) == 1
    # regions.REGIONS declares taiwan_strait before south_china_sea, so the dam
    # keeps the same theatre from refresh to refresh.
    assert records[0]["region_key"] == "taiwan_strait"


# --- the -99 no-data sentinel ----------------------------------------------


def test_the_minus_ninety_nine_sentinel_becomes_null_not_a_number():
    """Otherwise the popup reads "built -99, 99 m tall, -99 MW"."""
    (record,) = parse(MOSCOW_EMPTY)
    assert record["year"] is None
    assert record["height_m"] is None
    assert record["capacity_mcm"] is None
    assert record["area_skm"] is None
    assert record["power_mw"] is None
    # Not everything is missing: catchment and country survive, which is what
    # makes the record worth keeping at all.
    assert record["catchment_skm"] == 9110
    assert record["country"] == "Russia"


def test_a_cross_reference_of_zero_means_no_link_not_record_zero():
    """GRAND_ID uses 0 rather than -99 -- a third missing-value convention in
    the same row. 33,721 rows are not GRanD dams and 9,881 have no HydroLAKES
    counterpart."""
    (record,) = parse(MOSCOW_EMPTY)
    assert record["grand_id"] is None
    assert record["hylak_id"] is None

    (kakhovka,) = parse(KAKHOVKA)
    assert (kakhovka["grand_id"], kakhovka["hylak_id"]) == (4376, 129)
    assert kakhovka["orig_src"] == "GRanD"


def test_an_empty_text_cell_becomes_null():
    (record,) = parse(KAKHOVKA)
    assert record["url"] is None  # 97% of the file has none
    assert record["reservoir"] == "Kakhovskoye"

    (unnamed,) = parse(SYRIA_UNNAMED)
    assert unnamed["dam_name"] is None
    assert unnamed["river"] is None
    assert unnamed["main_use"] is None


def test_the_columns_that_are_actually_populated_survive_the_parse():
    (record,) = parse(KAKHOVKA)
    assert record["capacity_mcm"] == 18180.0
    assert record["year"] == 1955
    assert record["height_m"] == 37.0
    assert record["country"] == "Ukraine"
    assert record["river"] == "Dniepr"
    assert record["dam_type"] == "Dam"
    assert record["main_use"] == "Hydroelectricity"


def test_the_rare_power_and_url_columns_are_kept_where_they_exist():
    """POWER_MW is on 0.6% of rows and URL on 3%. Carried because when they are
    there they are the two most quotable facts on the record."""
    (record,) = parse(IRON_GATE)
    assert record["power_mw"] == 2200.0
    assert record["url"].endswith("Iron_Gate_I_Hydroelectric_Power_Station")
    assert record["name"] == "Iron Gate 1"


# --- naming the three quarters that have no name ---------------------------


def test_a_named_dam_keeps_its_own_name():
    assert parse(KAKHOVKA)[0]["name"] == "Kakhovskaya"
    assert parse(KAKHOVKA)[0]["named"] is True


def test_an_unnamed_dam_is_labelled_by_its_type_and_what_it_holds():
    """The obvious fallback -- name it by its river -- does not survive the
    data: of the 2,885 clipped records with no name, not one has a RIVER
    either. Capacity is what is actually there, and it is also the fact this
    layer exists to report."""
    (record,) = parse(SYRIA_UNNAMED)
    assert record["name"] == "Unnamed dam, 48 Mm³"
    assert record["named"] is False

    (donetsk,) = parse(DONETSK)
    assert donetsk["name"] == "Unnamed dam, 85 Mm³"


def test_an_unnamed_dam_with_no_capacity_says_only_what_is_known():
    """No invented number, and the barrier type is still GDW's own word for it."""
    (record,) = parse(MOSCOW_EMPTY)
    assert record["name"] == "Unnamed dam"
    assert record["named"] is False


def test_the_barrier_type_is_used_rather_than_assuming_every_row_is_a_dam():
    """1,152 rows are locks and 197 are lake control dams."""
    assert dams.display_name({"DAM_TYPE": "Lock"}, None) == "Unnamed lock"
    assert dams.display_name({"DAM_TYPE": "Lake Control Dam"}, 6970.0) == (
        "Unnamed lake control dam, 6,970 Mm³"
    )


def test_a_reservoir_name_labels_the_dam_without_claiming_to_be_its_name():
    """25 rows globally name the reservoir but not the structure. "Kalri Lake
    Dam" would assert a name GDW has not published; "Dam at Kalri Lake" asserts
    only the relationship."""
    row = {"DAM_NAME": "", "RES_NAME": "Kalri Lake", "DAM_TYPE": "Dam"}
    assert dams.display_name(row, 2051.5) == "Dam at Kalri Lake"


def test_capacity_in_the_label_stays_readable_at_every_magnitude():
    assert dams.display_name({"DAM_TYPE": "Dam"}, 18180.0) == "Unnamed dam, 18,180 Mm³"
    assert dams.display_name({"DAM_TYPE": "Dam"}, 4.928) == "Unnamed dam, 4.9 Mm³"
    assert dams.display_name({"DAM_TYPE": "Dam"}, 0.42) == "Unnamed dam, 0.42 Mm³"


# --- the publisher's own confidence ----------------------------------------


def test_the_publishers_quality_grade_is_kept_in_its_own_words():
    """GDW grades every row 1-5. Discarding that and presenting a "5:
    Unreliable" record identically to a "1: Verified" one would be us throwing
    away the publisher's own warning."""
    records = by_id(parse())
    assert records["gdw:372"]["quality"] == "1: Verified"
    assert records["gdw:54"]["quality"] == "3: Fair"


def test_the_grade_is_also_carried_as_a_number_so_it_can_be_sorted():
    records = by_id(parse())
    assert records["gdw:372"]["quality_rank"] == 1
    assert records["gdw:285"]["quality_rank"] == 2
    assert records["gdw:54"]["quality_rank"] == 3


# --- identity, attribution, timestamps -------------------------------------


def test_ids_are_namespaced_so_they_cannot_collide_with_another_layers():
    """Same convention as osm_infra's `osm:` prefix."""
    assert parse(KAKHOVKA)[0]["id"] == "gdw:54"
    assert all(r["id"].startswith("gdw:") for r in parse())


def test_every_record_names_its_publisher_and_carries_the_cc_by_attribution():
    """CC BY 4.0 obliges attribution, so it rides on the record rather than in a
    frontend table a new layer can forget to join."""
    for record in parse():
        assert record["publisher"] == "Global Dam Watch (GDW v1.0)"
        assert record["license"].startswith("CC BY 4.0")
        assert record["attribution"] == dams.ATTRIBUTION


def test_the_attribution_is_the_figshare_citation_verbatim():
    assert dams.ATTRIBUTION == (
        "Lehner, Bernhard; Beames, Penny; Mulligan, Mark; Zarfl, Christiane; "
        "De Felice, Luca; van Soesbergen, Arnout; et al. (2024). Global Dam Watch "
        "database version 1.0. figshare. Dataset. "
        "https://doi.org/10.6084/m9.figshare.25988293.v1"
    )


def test_the_timestamp_is_the_datasets_release_not_the_poll():
    """A dam surveyed in 2024 and downloaded today is evidence about 2024.
    Stamping it with the fetch time would make a frozen file look live."""
    released = dams._iso_to_unix("2024-08-28T22:51:21Z")
    assert released == 1724885481.0
    assert {r["time"] for r in parse(released=released)} == {released}
    assert {r["time"] for r in parse()} == {None}


def test_a_static_dataset_is_only_checked_weekly():
    """v1.0 has not moved since 2024-08-28; the poll is a change check, and the
    zip behind it is 70 MB."""
    assert dams.REFRESH_INTERVAL == 7 * 86400


# --- reading the archive ----------------------------------------------------


def test_the_attribute_table_is_found_by_suffix_and_decoded_as_utf8(tmp_path):
    """The member is located by name suffix, not by the full path, so a
    repackaged archive with a different directory prefix still parses. Iron
    Gate's administrative unit is "Mehedinți" -- if the decode were wrong the
    round trip would show it."""
    archive = tmp_path / "GDW_v1_0_shp.zip"
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("GDW_v1_0_shp/GDW_reservoirs_v1_0.prj", "not the file we want")
        zf.writestr("some_other_prefix/GDW_barriers_v1_0.txt", HEADER + "\n" + IRON_GATE + "\n")

    text = dams._read_member(str(archive))
    (record,) = dams.parse_barriers(text)
    assert record["name"] == "Iron Gate 1"
    assert record["region_key"] == "russia_ukraine"


def test_an_archive_without_the_attribute_table_fails_loudly(tmp_path):
    """Rather than publishing an empty layer over a good one."""
    archive = tmp_path / "wrong.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("GDW_v1_0_shp/GDW_barriers_v1_0.shp", b"\x00\x00")

    try:
        dams._read_member(str(archive))
    except RuntimeError as exc:
        assert "GDW_barriers_v1_0.txt" in str(exc)
    else:
        raise AssertionError("a missing attribute table must raise")


def test_an_empty_file_is_not_an_error():
    assert dams.parse_barriers("") == []
    assert dams.parse_barriers(HEADER + "\n") == []
