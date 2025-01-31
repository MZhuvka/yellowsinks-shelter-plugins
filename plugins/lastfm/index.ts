import {
	ACTIVITY_TYPE_LISTENING,
	DEFAULT_INTERVAL,
	DEFAULT_NAME,
	DISCORD_APP_ID,
	LFM_API_KEY,
} from "./cfg";
import { getAsset } from "./assets";
import { FluxStore } from "@uwu/shelter-defs";

const {
	plugin: { store },
	flux: { storesFlat, dispatcher },
} = shelter;

store.stamp ??= true;
store.ignoreSpotify ??= true;
store.service ??= "lfm";
store.lbLookup ??= true;
store.alwaysShare ??= false;

const UserStore = storesFlat.UserStore as FluxStore<{
	getCurrentUser(): { id: string };
}>;

const PresenceStore = storesFlat.PresenceStore as FluxStore<{
	getActivities(id: string): {
		type: number;
		application_id: string;
	}[];
}>;

const FETCH_SHPROX_UA_HEADER = {
	"X-Shprox-UA":
		"ShelterLastFm/0.0.0 ( https://github.com/yellowsink/shelter-plugins )",
};

interface Track {
	name: string;
	artist: string;
	album: string;
	albumArt?: string;
	url: string;
	//date: string;
	nowPlaying: boolean;
}

const setPresence = async (name = "", activity?: Track, start?: number) =>
	dispatcher.dispatch({
		type: "LOCAL_ACTIVITY_UPDATE",
		activity: activity
			? {
					name,
					//flags: 1,
					type: 2,
					details: activity.name,
					state: activity.artist,
					application_id: DISCORD_APP_ID,
					timestamps: store.stamp ? { start } : undefined,
					assets: {
						large_image:
							activity.albumArt && (await getAsset(activity.albumArt)),
						large_text: activity.album,
					},
			  }
			: null,
		socketId: "Last.fm@shelter",
	});

const getScrobbleLastfm = async () => {
	const params = new URLSearchParams({
		method: "user.getrecenttracks",
		user: store.user,
		api_key: LFM_API_KEY,
		format: "json",
		limit: "1",
		extended: "1",
	});

	const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
	if (!res.ok) return;

	const lastTrack = (await res.json())?.recenttracks?.track?.[0];
	if (!lastTrack) return;

	return {
		name: lastTrack.name,
		artist: lastTrack.artist.name,
		album: lastTrack.album["#text"],
		albumArt: lastTrack.image[3]["#text"],
		url: lastTrack.url,
		//date: lastTrack.date?.["#text"] ?? "now",
		nowPlaying: !!lastTrack["@attr"]?.nowplaying,
	} as Track;
};

// finds a MBID and adds it to a track if it doesnt exist
const listenBrainzLookupAdditional = async (basicTrack) => {
	// following the behaviour of the webapp, if theres not an MBID, do a search.
	if (!store.lbLookup) return;
	if (basicTrack.additional_info?.release_mbid) return;

	try {
		const metaRes = await fetch(
			`https://shcors.uwu.network/https://api.listenbrainz.org/1/metadata/lookup/?${new URLSearchParams(
				{
					recording_name: basicTrack.track_name,
					artist_name: basicTrack.artist_name,
					metadata: "true",
					inc: "artist tag release",
				},
			)}`,
			{ headers: FETCH_SHPROX_UA_HEADER },
		).then((r) => r.json());

		basicTrack.additional_info = { ...basicTrack?.additional_info, ...metaRes };
	} catch (e) {
		console.error(
			"SHELTER LASTFM: finding listenbrainz MBID for track",
			basicTrack,
			"failed, ",
			e,
		);
	}
};

const getScrobbleListenbrainz = async () => {
	// use the shelter proxy to set the user agent as required by musicbrainz
	const nowPlayingRes = await fetch(
		`https://shcors.uwu.network/https://api.listenbrainz.org/1/user/${store.user}/playing-now`,
		{ headers: FETCH_SHPROX_UA_HEADER },
	).then((r) => r.json());

	if (!nowPlayingRes.payload.count) return;

	const track = nowPlayingRes.payload.listens[0].track_metadata;

	await listenBrainzLookupAdditional(track);

	let albumArtUrl: string;

	if (track.additional_info?.release_mbid) {
		// first check for release art and then for release group art
		const relArtCheck = await fetch(
			`https://coverartarchive.org/release/${track.additional_info?.release_mbid}/front`,
			{ method: "HEAD", redirect: "manual" },
		);
		if (relArtCheck.status !== 404) {
			// ok fine we have album art for this release
			albumArtUrl = `https://aart.yellows.ink/release/${track.additional_info.release_mbid}.webp`;
		} else {
			// okay, get the release group
			const rgLookup = await fetch(
				`https://shcors.uwu.network/https://musicbrainz.org/ws/2/release/${track.additional_info.release_mbid}?fmt=json&inc=release-groups`,
				{ headers: FETCH_SHPROX_UA_HEADER },
			);
			if (rgLookup.ok) {
				const releaseJson = await rgLookup.json();

				albumArtUrl = `https://aart.yellows.ink/release-group/${releaseJson["release-group"].id}.webp`;
			}
		}
	}

	if (albumArtUrl) {
		// test
		const testRes = await fetch(albumArtUrl, { method: "HEAD" });
		if (!testRes.ok) albumArtUrl = undefined;
	}

	return {
		name: track.track_name,
		artist: track.artist_name,
		album: track.release_name,
		albumArt: albumArtUrl,
		url: track.additional_info?.recording_mbid
			? `https://musicbrainz.org/recording/${track.additional_info.recording_mbid}`
			: `NOURL_${track.track_name}:${track.artist_name}:${track.release_name}`,
		//date: "now", // not returned by api
		nowPlaying: nowPlayingRes.payload.listens[0].playing_now,
	} as Track;
};

let lastUrl: string;
let startTimestamp: number;

const updateStatus = async () => {
	if (!store.user) return setPresence();

	if (store.ignoreSpotify)
		for (const activity of PresenceStore.getActivities(
			UserStore.getCurrentUser().id,
		))
			if (
				activity?.type === ACTIVITY_TYPE_LISTENING &&
				activity.application_id !== DISCORD_APP_ID
			)
				return setPresence();

	const getFn =
		store.service === "lbz" ? getScrobbleListenbrainz : getScrobbleLastfm;

	const lastTrack = await getFn();
	if (!lastTrack?.nowPlaying) {
		startTimestamp = null;
		return setPresence();
	}

	if (lastTrack.url !== lastUrl || !startTimestamp) {
		startTimestamp = Date.now();
	}

	lastUrl = lastTrack.url;

	let appName = store.appName || DEFAULT_NAME;
	// screw it theres nothing wrong with eval okay???
	// obviously im not serious on that but really this is fine -- sink
	appName = appName.replaceAll(/{{(.+)}}/g, (_, code) =>
		eval(`(c)=>{with(c){try{return ${code}}catch(e){return e}}}`)(lastTrack),
	);

	await setPresence(appName, lastTrack, startTimestamp);
};

let interval;
const restartLoop = () => (
	interval && clearInterval(interval),
	(interval = setInterval(updateStatus, store.interval || DEFAULT_INTERVAL))
);

const unpatch = shelter.patcher.after(
	"getActivities",
	shelter.flux.stores.LocalActivityStore,
	(_, res) => {
		if (!store.alwaysShare) return;
		res.filter = function (predicate) {
			if (!predicate.toString().includes("shouldShowActivity")) {
				return Array.prototype.filter.call(this, predicate);
			}
			return Array.prototype.filter.call(this, (event) => {
				if (event?.type === 2 && event.application_id === DISCORD_APP_ID) {
					return true;
				}
				return predicate(event);
			});
		};
		return res;
	},
);

restartLoop();
export const onUnload = () => (
	clearInterval(interval), setPresence(), unpatch()
);

export * from "./Settings";
