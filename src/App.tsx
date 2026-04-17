import { importLibrary, setOptions } from '@googlemaps/js-api-loader'
import area from '@turf/area'
import { polygon } from '@turf/helpers'
import mapboxgl from 'mapbox-gl'
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import 'mapbox-gl/dist/mapbox-gl.css'
import './App.css'

type ProviderType = 'google' | 'mapbox'
type Unit = 'm2' | 'acre' | 'hectare'
type ToolMode = 'pan' | 'marker' | 'boundary'

type Boundary = {
  id: string
  name: string
  plotId: string
  coordinates: [number, number][]
  areaOverrideM2?: number
  unit: Unit
}

type MarkerPoint = {
  id: string
  name: string
  lat: number
  lng: number
}

type Pane = {
  id: string
  provider: ProviderType
}

type MapViewState = {
  center: { lat: number; lng: number }
  zoom: number
}

type ApiKeys = {
  googleApiKey: string
  mapboxToken: string
}

const STORAGE_KEY = 'map-poc-state-v1'
const UNIT_OPTIONS: Unit[] = ['m2', 'acre', 'hectare']

const unitLabel: Record<Unit, string> = {
  m2: 'm²',
  acre: 'acre',
  hectare: 'hectare',
}

const providerLabel: Record<ProviderType, string> = {
  google: 'Google Maps',
  mapbox: 'Mapbox',
}

const DEFAULT_VIEW: MapViewState = {
  center: { lat: 20.5937, lng: 78.9629 },
  zoom: 5,
}
const ENV_API_KEYS: ApiKeys = {
  googleApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '',
  mapboxToken: import.meta.env.VITE_MAPBOX_ACCESS_TOKEN ?? '',
}
const CENTER_EPSILON = 0.00001
const ZOOM_EPSILON = 0.01

const randomId = (prefix: string) =>
  `${prefix}_${Math.random().toString(36).slice(2, 10)}`

const m2ToUnit = (m2: number, unit: Unit) => {
  if (unit === 'acre') return m2 / 4046.8564224
  if (unit === 'hectare') return m2 / 10000
  return m2
}

const unitToM2 = (value: number, unit: Unit) => {
  if (unit === 'acre') return value * 4046.8564224
  if (unit === 'hectare') return value * 10000
  return value
}

const computePolygonAreaM2 = (coordinates: [number, number][]) => {
  if (coordinates.length < 3) return 0
  return area(polygon([[...coordinates, coordinates[0]]]))
}

const parseLatLng = (value: string) => {
  const [latString, lngString] = value.split(',').map((chunk) => chunk.trim())
  const lat = Number(latString)
  const lng = Number(lngString)
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng }
  }
  return null
}

const isViewStateSimilar = (a: MapViewState, b: MapViewState) =>
  Math.abs(a.center.lat - b.center.lat) < CENTER_EPSILON &&
  Math.abs(a.center.lng - b.center.lng) < CENTER_EPSILON &&
  Math.abs(a.zoom - b.zoom) < ZOOM_EPSILON

const parseCoordinatePairs = (raw: string): [number, number][] =>
  raw
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [lngString, latString] = pair.split(',')
      const lng = Number(lngString)
      const lat = Number(latString)
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return [lng, lat] as [number, number]
    })
    .filter((pair): pair is [number, number] => pair !== null)

const parseKmlContent = (content: string) => {
  const parser = new DOMParser()
  const xml = parser.parseFromString(content, 'application/xml')
  const parseError = xml.querySelector('parsererror')
  if (parseError) {
    throw new Error('Invalid KML file.')
  }

  const importedMarkers: MarkerPoint[] = []
  const importedBoundaries: Boundary[] = []

  const placemarks = Array.from(xml.querySelectorAll('Placemark'))
  placemarks.forEach((placemark, index) => {
    const placemarkName =
      placemark.querySelector('name')?.textContent?.trim() || `KML ${index + 1}`

    const pointCoordinatesNode = placemark.querySelector('Point > coordinates')
    if (pointCoordinatesNode?.textContent) {
      const coords = parseCoordinatePairs(pointCoordinatesNode.textContent)
      if (coords[0]) {
        const [lng, lat] = coords[0]
        importedMarkers.push({
          id: randomId('marker'),
          name: placemarkName,
          lat,
          lng,
        })
      }
    }

    const polygonNodes = Array.from(
      placemark.querySelectorAll('Polygon > outerBoundaryIs > LinearRing > coordinates'),
    )
    polygonNodes.forEach((polygonNode, polygonIndex) => {
      if (!polygonNode.textContent) return
      const coordinates = parseCoordinatePairs(polygonNode.textContent)
      if (coordinates.length < 3) return
      importedBoundaries.push({
        id: randomId('boundary'),
        name:
          polygonNodes.length > 1
            ? `${placemarkName} ${polygonIndex + 1}`
            : placemarkName,
        plotId: `KML-${importedBoundaries.length + 1}`,
        coordinates,
        unit: 'm2',
      })
    })
  })

  return { importedMarkers, importedBoundaries }
}

const getBoundaryCenter = (coordinates: [number, number][]) => {
  if (!coordinates.length) return DEFAULT_VIEW.center
  const totals = coordinates.reduce(
    (acc, [lng, lat]) => ({ lat: acc.lat + lat, lng: acc.lng + lng }),
    { lat: 0, lng: 0 },
  )
  return {
    lat: totals.lat / coordinates.length,
    lng: totals.lng / coordinates.length,
  }
}

function App() {
  const [apiKeys] = useState<ApiKeys>(ENV_API_KEYS)
  const [viewState, setViewState] = useState<MapViewState>(DEFAULT_VIEW)
  const [panes, setPanes] = useState<Pane[]>([
    { id: randomId('pane'), provider: 'google' },
    { id: randomId('pane'), provider: 'mapbox' },
  ])
  const [toolMode, setToolMode] = useState<ToolMode>('pan')
  const [boundaries, setBoundaries] = useState<Boundary[]>([])
  const [boundaryDraft, setBoundaryDraft] = useState<[number, number][]>([])
  const [markers, setMarkers] = useState<MarkerPoint[]>([])
  const [searchText, setSearchText] = useState('')
  const [latLngText, setLatLngText] = useState('')
  const [statusText, setStatusText] = useState('Ready')
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null)
  const [selectedBoundaryId, setSelectedBoundaryId] = useState<string | null>(
    null,
  )
  const [gpsPoint, setGpsPoint] = useState<{ lat: number; lng: number } | null>(
    null,
  )
  const [gpsError, setGpsError] = useState('')
  const [gpsEnabled, setGpsEnabled] = useState(false)
  const [paneToAdd, setPaneToAdd] = useState<ProviderType>('google')
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false)
  const kmlInputRef = useRef<HTMLInputElement | null>(null)
  const googleMapsApiRef = useRef<typeof google.maps | null>(null)
  const googleSearchMapRef = useRef<google.maps.Map | null>(null)
  const googleOptionsSetRef = useRef(false)
  const gpsWatchIdRef = useRef<number | null>(null)
  const [googleReady, setGoogleReady] = useState(false)

  const selectedMarker = useMemo(
    () => markers.find((marker) => marker.id === selectedMarkerId) ?? null,
    [markers, selectedMarkerId],
  )
  const selectedBoundary = useMemo(
    () => boundaries.find((item) => item.id === selectedBoundaryId) ?? null,
    [boundaries, selectedBoundaryId],
  )

  useEffect(() => {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as {
        viewState?: MapViewState
        panes?: Pane[]
        boundaries?: Boundary[]
        markers?: MarkerPoint[]
      }
      if (parsed.viewState) setViewState(parsed.viewState)
      if (parsed.panes?.length) setPanes(parsed.panes)
      if (parsed.boundaries) setBoundaries(parsed.boundaries)
      if (parsed.markers) setMarkers(parsed.markers)
    } catch {
      setStatusText('Saved state could not be loaded.')
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ viewState, panes, boundaries, markers }),
    )
  }, [viewState, panes, boundaries, markers])

  useEffect(() => {
    if (!apiKeys.googleApiKey) {
      googleMapsApiRef.current = null
      setGoogleReady(false)
      return
    }
    if (!googleOptionsSetRef.current) {
      setOptions({
        key: apiKeys.googleApiKey,
        v: 'weekly',
        libraries: ['places', 'geometry'],
      })
      googleOptionsSetRef.current = true
    }
    void importLibrary('maps')
      .then(() => importLibrary('places'))
      .then(() => {
        googleMapsApiRef.current = window.google.maps
        setGoogleReady(true)
      })
      .catch(() => {
        setGoogleReady(false)
        setStatusText('Google Maps failed to load. Check key.')
      })
  }, [apiKeys.googleApiKey])

  useEffect(() => {
    if (!gpsEnabled) {
      if (gpsWatchIdRef.current !== null) {
        navigator.geolocation.clearWatch(gpsWatchIdRef.current)
      }
      gpsWatchIdRef.current = null
      return
    }

    if (!navigator.geolocation) {
      setGpsError('Geolocation not supported in this browser.')
      return
    }

    gpsWatchIdRef.current = navigator.geolocation.watchPosition(
      (position) => {
        setGpsError('')
        setGpsPoint({
          lat: position.coords.latitude,
          lng: position.coords.longitude,
        })
      },
      (error) => {
        setGpsError(error.message)
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 },
    )

    return () => {
      if (gpsWatchIdRef.current !== null) {
        navigator.geolocation.clearWatch(gpsWatchIdRef.current)
      }
    }
  }, [gpsEnabled])

  const addMarker = (lat: number, lng: number) => {
    const marker: MarkerPoint = {
      id: randomId('marker'),
      name: 'Point',
      lat,
      lng,
    }
    setMarkers((current) => [...current, marker])
    setSelectedMarkerId(marker.id)
    setViewState((current) => ({ ...current, center: { lat, lng }, zoom: 15 }))
  }

  const addBoundaryFromDraft = () => {
    if (boundaryDraft.length < 3) return
    const center = getBoundaryCenter(boundaryDraft)
    const newBoundary: Boundary = {
      id: randomId('boundary'),
      name: `Boundary ${boundaries.length + 1}`,
      plotId: `P-${boundaries.length + 1}`,
      coordinates: boundaryDraft,
      unit: 'm2',
    }
    setBoundaries((current) => [...current, newBoundary])
    setSelectedBoundaryId(newBoundary.id)
    setBoundaryDraft([])
    setViewState((current) => ({ ...current, center, zoom: Math.max(current.zoom, 17) }))
  }

  const onMapClick = (lat: number, lng: number) => {
    if (toolMode === 'marker') {
      addMarker(lat, lng)
      setStatusText('Marker added and synced to all panes.')
      return
    }
    if (toolMode === 'boundary') {
      setBoundaryDraft((current) => [...current, [lng, lat]])
      setStatusText('Boundary point added. Double-click map to close boundary.')
    }
  }

  const onMapDoubleClick = () => {
    if (toolMode === 'boundary' && boundaryDraft.length >= 3) {
      addBoundaryFromDraft()
      setStatusText('Boundary created.')
    }
  }

  const deleteMarker = (id: string) => {
    setMarkers((current) => current.filter((marker) => marker.id !== id))
    if (selectedMarkerId === id) setSelectedMarkerId(null)
  }

  const clearMarkers = () => {
    setMarkers([])
    setSelectedMarkerId(null)
    setStatusText('All markers cleared.')
  }

  const clearBoundaries = () => {
    setBoundaries([])
    setBoundaryDraft([])
    setSelectedBoundaryId(null)
    setStatusText('All boundaries cleared.')
  }

  const clearAllMapData = () => {
    setMarkers([])
    setBoundaries([])
    setBoundaryDraft([])
    setSelectedMarkerId(null)
    setSelectedBoundaryId(null)
    setStatusText('All markers and boundaries cleared.')
  }

  const importKmlFile = async (file: File) => {
    try {
      const content = await file.text()
      const { importedMarkers, importedBoundaries } = parseKmlContent(content)
      if (!importedMarkers.length && !importedBoundaries.length) {
        setStatusText('KML imported, but no points/polygons found.')
        return
      }
      if (importedMarkers.length) {
        setMarkers((current) => [...current, ...importedMarkers])
      }
      if (importedBoundaries.length) {
        setBoundaries((current) => [...current, ...importedBoundaries])
      }

      const firstCenter = importedMarkers[0]
        ? { lat: importedMarkers[0].lat, lng: importedMarkers[0].lng }
        : getBoundaryCenter(importedBoundaries[0].coordinates)
      setViewState((current) => ({ ...current, center: firstCenter, zoom: 16 }))
      setStatusText(
        `KML imported: ${importedMarkers.length} marker(s), ${importedBoundaries.length} boundary(s).`,
      )
    } catch {
      setStatusText('Failed to import KML.')
    }
  }

  const saveBoundary = (id: string, patch: Partial<Boundary>) => {
    setBoundaries((current) =>
      current.map((boundary) =>
        boundary.id === id ? { ...boundary, ...patch } : boundary,
      ),
    )
  }

  const removeBoundary = (id: string) => {
    setBoundaries((current) => current.filter((boundary) => boundary.id !== id))
    if (selectedBoundaryId === id) setSelectedBoundaryId(null)
  }

  const searchByText = async () => {
    const query = searchText.trim()
    if (!query) return
    if (!googleMapsApiRef.current) {
      setStatusText('Google Places unavailable. Add valid Google API key.')
      return
    }
    try {
      if (!googleSearchMapRef.current) {
        const div = document.createElement('div')
        googleSearchMapRef.current = new googleMapsApiRef.current.Map(div)
      }
      const places = new googleMapsApiRef.current.places.PlacesService(
        googleSearchMapRef.current,
      )
      const result = await new Promise<google.maps.places.PlaceResult | null>(
        (resolve) => {
          places.textSearch({ query }, (items, status) => {
            if (
              status !== googleMapsApiRef.current?.places.PlacesServiceStatus.OK
            ) {
              resolve(null)
              return
            }
            resolve(items?.[0] ?? null)
          })
        },
      )
      const location = result?.geometry?.location
      if (!location) {
        setStatusText('No matching place found.')
        return
      }
      addMarker(location.lat(), location.lng())
      setStatusText('Place found via Google Places and marker added.')
    } catch {
      setStatusText('Place search failed.')
    }
  }

  const plotLatLng = () => {
    const location = parseLatLng(latLngText)
    if (!location) {
      setStatusText('Invalid lat,lng format. Example: 12.98,77.59')
      return
    }
    addMarker(location.lat, location.lng)
    setStatusText('Lat/Lng point plotted.')
  }

  const onPaneViewChange = useCallback((_sourcePaneId: string, _next: MapViewState) => {
    // Intentionally disabled: camera sync across providers causes jitter because
    // Google and Mapbox camera/zoom scales differ. We only sync data overlays.
  }, [])

  return (
    <div className="app">
      <header className="toolbar">
        <h1>Map Service Comparison POC</h1>
        <p>Search, navigate, draw boundaries, measure area, compare providers.</p>
      </header>

      <section className={`layout ${isSidebarCollapsed ? 'layout-collapsed' : ''}`}>
        <aside className={`sidebar ${isSidebarCollapsed ? 'collapsed' : ''}`}>
          <button
            className="collapse-btn"
            onClick={() => setIsSidebarCollapsed((current) => !current)}
          >
            {isSidebarCollapsed ? 'Open Controls' : 'Hide Controls'}
          </button>
          {!isSidebarCollapsed ? (
            <>
              <div className="control-group">
                <label>Tool</label>
                <div className="row">
                  <button
                    className={toolMode === 'pan' ? 'active' : ''}
                    onClick={() => setToolMode('pan')}
                  >
                    Pan
                  </button>
                  <button
                    className={toolMode === 'marker' ? 'active' : ''}
                    onClick={() => setToolMode('marker')}
                  >
                    Add Marker
                  </button>
                  <button
                    className={toolMode === 'boundary' ? 'active' : ''}
                    onClick={() => setToolMode('boundary')}
                  >
                    Draw Boundary
                  </button>
                  <button
                    disabled={toolMode !== 'boundary' || boundaryDraft.length < 3}
                    onClick={addBoundaryFromDraft}
                  >
                    Finish Boundary
                  </button>
                  <button onClick={clearAllMapData}>Clear All</button>
                </div>
              </div>

              <div className="control-group">
                <label>Search Place (Google Places)</label>
                <div className="row">
                  <input
                    value={searchText}
                    onChange={(event) => setSearchText(event.target.value)}
                    placeholder="Type place name"
                  />
                  <button onClick={() => void searchByText()}>Search</button>
                </div>
              </div>

              <div className="control-group">
                <label>Plot by Lat,Lng</label>
                <div className="row">
                  <input
                    value={latLngText}
                    onChange={(event) => setLatLngText(event.target.value)}
                    placeholder="12.9716,77.5946"
                  />
                  <button onClick={plotLatLng}>Plot</button>
                </div>
              </div>

              <div className="control-group">
                <label>Panes</label>
                <div className="row">
                  <select
                    value={paneToAdd}
                    onChange={(event) => setPaneToAdd(event.target.value as ProviderType)}
                  >
                    <option value="google">Google Maps</option>
                    <option value="mapbox">Mapbox</option>
                  </select>
                  <button
                    onClick={() =>
                      setPanes((current) => [
                        ...current,
                        { id: randomId('pane'), provider: paneToAdd },
                      ])
                    }
                  >
                    Add Pane
                  </button>
                </div>
              </div>

              <div className="control-group">
                <label>KML Import</label>
                <div className="row">
                  <button onClick={() => kmlInputRef.current?.click()}>Upload KML</button>
                  <input
                    ref={kmlInputRef}
                    type="file"
                    accept=".kml,application/vnd.google-earth.kml+xml,application/xml,text/xml"
                    className="hidden-input"
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      if (file) {
                        void importKmlFile(file)
                      }
                      event.currentTarget.value = ''
                    }}
                  />
                </div>
              </div>
            </>
          ) : null}

          <h2>Marker Details</h2>
          <div className="row">
            <button onClick={clearMarkers}>Clear Markers</button>
          </div>
          {selectedMarker ? (
            <div className="card">
              <p>
                <strong>{selectedMarker.name}</strong>
              </p>
              <p>
                {selectedMarker.lat.toFixed(6)}, {selectedMarker.lng.toFixed(6)}
              </p>
              <div className="row">
                <button
                  onClick={() =>
                    window.open(
                      `https://www.google.com/maps/dir/?api=1&destination=${selectedMarker.lat},${selectedMarker.lng}`,
                      '_blank',
                    )
                  }
                >
                  Navigate
                </button>
                <button onClick={() => deleteMarker(selectedMarker.id)}>Delete</button>
              </div>
            </div>
          ) : (
            <p>No marker selected</p>
          )}

          <h2>Boundary Details</h2>
          <div className="row">
            <button onClick={clearBoundaries}>Clear Boundaries</button>
          </div>
          {selectedBoundary ? (
            <BoundaryEditor
              boundary={selectedBoundary}
              onSave={saveBoundary}
              onDelete={removeBoundary}
            />
          ) : (
            <p>No boundary selected</p>
          )}

          <h2>Status</h2>
          <p>{statusText}</p>
          {gpsError ? <p className="error">GPS: {gpsError}</p> : null}
          {gpsPoint ? (
            <p>
              GPS: {gpsPoint.lat.toFixed(6)}, {gpsPoint.lng.toFixed(6)}
            </p>
          ) : null}
          <p>Keys are preconfigured in environment variables.</p>
        </aside>

        <main className="map-grid">
          {panes.map((pane) => (
            <div className="pane" key={pane.id}>
              <div className="pane-header">
                <strong>{providerLabel[pane.provider]}</strong>
                <div className="row">
                  <button onClick={() => setGpsEnabled((current) => !current)}>
                    {gpsEnabled ? 'Stop GPS' : 'Start GPS'}
                  </button>
                  <button
                    onClick={() =>
                      setPanes((current) =>
                        current.length <= 1
                          ? current
                          : current.filter((item) => item.id !== pane.id),
                      )
                    }
                  >
                    Remove
                  </button>
                </div>
              </div>
              {pane.provider === 'google' ? (
                <PaneErrorBoundary>
                  <GooglePane
                    paneId={pane.id}
                    apiKey={apiKeys.googleApiKey}
                    googleReady={googleReady}
                    viewState={viewState}
                    onPaneViewChange={onPaneViewChange}
                    markers={markers}
                    boundaries={boundaries}
                    boundaryDraft={boundaryDraft}
                    gpsPoint={gpsPoint}
                    onMapClick={onMapClick}
                    onMapDoubleClick={onMapDoubleClick}
                    onSelectMarker={setSelectedMarkerId}
                    onSelectBoundary={setSelectedBoundaryId}
                  />
                </PaneErrorBoundary>
              ) : (
                <PaneErrorBoundary>
                  <MapboxPane
                    paneId={pane.id}
                    token={apiKeys.mapboxToken}
                    viewState={viewState}
                    onPaneViewChange={onPaneViewChange}
                    markers={markers}
                    boundaries={boundaries}
                    boundaryDraft={boundaryDraft}
                    gpsPoint={gpsPoint}
                    onMapClick={onMapClick}
                    onMapDoubleClick={onMapDoubleClick}
                    onSelectMarker={setSelectedMarkerId}
                    onSelectBoundary={setSelectedBoundaryId}
                  />
                </PaneErrorBoundary>
              )}
            </div>
          ))}
        </main>
      </section>

    </div>
  )
}

type BoundaryEditorProps = {
  boundary: Boundary
  onSave: (id: string, patch: Partial<Boundary>) => void
  onDelete: (id: string) => void
}

function BoundaryEditor({ boundary, onSave, onDelete }: BoundaryEditorProps) {
  const areaM2 = computePolygonAreaM2(boundary.coordinates)
  const displayM2 = boundary.areaOverrideM2 ?? areaM2
  const displayArea = m2ToUnit(displayM2, boundary.unit)

  return (
    <div className="card">
      <label>Name</label>
      <input
        value={boundary.name}
        onChange={(event) => onSave(boundary.id, { name: event.target.value })}
      />
      <label>Plot ID</label>
      <input
        value={boundary.plotId}
        onChange={(event) => onSave(boundary.id, { plotId: event.target.value })}
      />
      <label>Unit</label>
      <select
        value={boundary.unit}
        onChange={(event) => onSave(boundary.id, { unit: event.target.value as Unit })}
      >
        {UNIT_OPTIONS.map((unit) => (
          <option key={unit} value={unit}>
            {unitLabel[unit]}
          </option>
        ))}
      </select>
      <label>Plot Area ({unitLabel[boundary.unit]})</label>
      <input
        value={displayArea.toFixed(3)}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) {
            onSave(boundary.id, { areaOverrideM2: unitToM2(value, boundary.unit) })
          }
        }}
      />
      <small>
        Computed: {m2ToUnit(areaM2, boundary.unit).toFixed(3)} {unitLabel[boundary.unit]}
      </small>
      <button onClick={() => onDelete(boundary.id)}>Delete Boundary</button>
    </div>
  )
}

type CommonPaneProps = {
  paneId: string
  viewState: MapViewState
  onPaneViewChange: (sourcePaneId: string, next: MapViewState) => void
  markers: MarkerPoint[]
  boundaries: Boundary[]
  boundaryDraft: [number, number][]
  gpsPoint: { lat: number; lng: number } | null
  onMapClick: (lat: number, lng: number) => void
  onMapDoubleClick: () => void
  onSelectMarker: (id: string) => void
  onSelectBoundary: (id: string) => void
}

type PaneErrorBoundaryState = { hasError: boolean }

class PaneErrorBoundary extends Component<
  { children: ReactNode },
  PaneErrorBoundaryState
> {
  constructor(props: { children: ReactNode }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): PaneErrorBoundaryState {
    return { hasError: true }
  }

  componentDidUpdate(prevProps: { children: ReactNode }) {
    if (prevProps.children !== this.props.children && this.state.hasError) {
      this.setState({ hasError: false })
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="map-placeholder">
          Provider failed to render. Re-open key popup and Save Keys again.
        </div>
      )
    }
    return this.props.children
  }
}

function markerHtml() {
  return `<div class="marker-dot"></div>`
}

function MapboxPane({
  paneId,
  token,
  viewState,
  onPaneViewChange,
  markers,
  boundaries,
  boundaryDraft,
  gpsPoint,
  onMapClick,
  onMapDoubleClick,
  onSelectMarker,
  onSelectBoundary,
}: CommonPaneProps & { token: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<mapboxgl.Map | null>(null)
  const markerRefs = useRef<mapboxgl.Marker[]>([])
  const isSyncingRef = useRef(false)
  const isInteractingRef = useRef(false)
  const boundariesClickBoundRef = useRef(false)
  const onMapClickRef = useRef(onMapClick)
  const onMapDoubleClickRef = useRef(onMapDoubleClick)
  const onPaneViewChangeRef = useRef(onPaneViewChange)
  const [mapError, setMapError] = useState('')
  const [mapReady, setMapReady] = useState(false)
  const [styleReadyTick, setStyleReadyTick] = useState(0)
  const normalizedToken = token.trim()
  const hasToken = normalizedToken.length > 0

  const ensureBoundaryOverlay = useCallback(
    (map: mapboxgl.Map) => {
      if (!map.isStyleLoaded()) return false
      const emptyData: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: [],
      }
      if (!map.getSource('boundaries')) {
        map.addSource('boundaries', { type: 'geojson', data: emptyData })
      }
      if (!map.getLayer('boundaries-fill')) {
        map.addLayer({
          id: 'boundaries-fill',
          type: 'fill',
          source: 'boundaries',
          paint: { 'fill-color': '#2a6af6', 'fill-opacity': 0.2 },
        })
        boundariesClickBoundRef.current = false
      }
      if (!map.getLayer('boundaries-line')) {
        map.addLayer({
          id: 'boundaries-line',
          type: 'line',
          source: 'boundaries',
          paint: { 'line-color': '#2a6af6', 'line-width': 2 },
        })
      }
      if (!boundariesClickBoundRef.current) {
        map.on('click', 'boundaries-fill', (event) => {
          const id = event.features?.[0]?.properties?.id
          if (id) onSelectBoundary(String(id))
        })
        boundariesClickBoundRef.current = true
      }
      return true
    },
    [onSelectBoundary],
  )

  useEffect(() => {
    onMapClickRef.current = onMapClick
    onMapDoubleClickRef.current = onMapDoubleClick
    onPaneViewChangeRef.current = onPaneViewChange
  }, [onMapClick, onMapDoubleClick, onPaneViewChange])

  useEffect(() => {
    if (!containerRef.current || !hasToken || mapRef.current) return
    try {
      boundariesClickBoundRef.current = false
      mapboxgl.accessToken = normalizedToken
      const map = new mapboxgl.Map({
        container: containerRef.current,
        accessToken: normalizedToken,
        style: 'mapbox://styles/mapbox/satellite-streets-v12',
        center: [viewState.center.lng, viewState.center.lat],
        zoom: viewState.zoom,
      })
      mapRef.current = map
      setMapError('')
      setMapReady(false)
      map.doubleClickZoom.disable()
      map.on('movestart', () => {
        isInteractingRef.current = true
      })
      map.on('load', () => {
        setMapReady(true)
        setMapError('')
        try {
          ensureBoundaryOverlay(map)
        } catch {
          // no-op: retried on styledata
        }
        setStyleReadyTick((current) => current + 1)
      })
      map.on('styledata', () => {
        if (map.isStyleLoaded()) {
          try {
            ensureBoundaryOverlay(map)
          } catch {
            // no-op: next style tick retries
          }
          setStyleReadyTick((current) => current + 1)
        }
      })
      map.on('error', (event) => {
        const message = String(event?.error?.message ?? '').trim()
        if (!message) return
        const lowered = message.toLowerCase()
        // Ignore transient style/lifecycle/network issues that can happen while zooming.
        if (
          lowered.includes('style is not done loading') ||
          lowered.includes('source') ||
          lowered.includes('layer') ||
          lowered.includes('network') ||
          lowered.includes('tile') ||
          lowered.includes('failed to fetch')
        ) {
          return
        }
        // Only surface likely-fatal auth failures.
        if (
          lowered.includes('access token') ||
          lowered.includes('unauthorized') ||
          lowered.includes('forbidden') ||
          lowered.includes('401') ||
          lowered.includes('403')
        ) {
          setMapError(`Mapbox error: ${message}`)
        }
      })

      map.on('moveend', () => {
        if (isSyncingRef.current) {
          isSyncingRef.current = false
          return
        }
        isInteractingRef.current = false
        const center = map.getCenter()
        const next = {
          center: { lat: center.lat, lng: center.lng },
          zoom: map.getZoom(),
        }
        onPaneViewChangeRef.current(paneId, next)
      })

      map.on('click', (event) => {
        onMapClickRef.current(event.lngLat.lat, event.lngLat.lng)
      })
      map.on('dblclick', () => onMapDoubleClickRef.current())

      return () => {
        map.remove()
        mapRef.current = null
      }
    } catch {
      setMapError('Mapbox failed to initialize with the current token.')
    }
  }, [
    paneId,
    hasToken,
    normalizedToken,
    ensureBoundaryOverlay,
  ])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (isInteractingRef.current) return
    const current = map.getCenter()
    const currentView: MapViewState = {
      center: { lat: current.lat, lng: current.lng },
      zoom: map.getZoom(),
    }
    if (isViewStateSimilar(currentView, viewState)) return
    isSyncingRef.current = true
    map.jumpTo({
      center: [viewState.center.lng, viewState.center.lat],
      zoom: viewState.zoom,
    })
  }, [viewState])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    markerRefs.current.forEach((marker) => marker.remove())
    markerRefs.current = markers.map((point) => {
      const element = document.createElement('div')
      element.innerHTML = markerHtml()
      element.addEventListener('click', (event) => {
        event.stopPropagation()
        onSelectMarker(point.id)
      })
      const marker = new mapboxgl.Marker(element.firstElementChild as HTMLElement)
        .setLngLat([point.lng, point.lat])
        .addTo(map)
      return marker
    })
  }, [mapReady, markers, onSelectMarker])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    if (!map.isStyleLoaded()) return
    try {
      if (!ensureBoundaryOverlay(map)) return
      const features = boundaries.map((boundary) => ({
        type: 'Feature',
        properties: { id: boundary.id },
        geometry: {
          type: 'Polygon',
          coordinates: [[...boundary.coordinates, boundary.coordinates[0]]],
        },
      }))
      if (boundaryDraft.length >= 3) {
        features.push({
          type: 'Feature',
          properties: { id: 'draft' },
          geometry: {
            type: 'Polygon',
            coordinates: [[...boundaryDraft, boundaryDraft[0]]],
          },
        })
      }
      const data = { type: 'FeatureCollection', features } as GeoJSON.FeatureCollection
      const source = map.getSource('boundaries') as mapboxgl.GeoJSONSource | undefined
      source?.setData(data)
    } catch {
      return
    }
  }, [boundaries, boundaryDraft, ensureBoundaryOverlay, mapReady, styleReadyTick])

  useEffect(() => {
    // Stability mode: skip Mapbox GPS layers to avoid style race crashes.
    void gpsPoint
    void mapReady
    void styleReadyTick
  }, [gpsPoint, mapReady, styleReadyTick])

  if (!normalizedToken) {
    return (
      <div className="map-placeholder">
        Missing `VITE_MAPBOX_ACCESS_TOKEN` in deployment environment.
      </div>
    )
  }
  if (mapError) {
    return <div className="map-placeholder">{mapError}</div>
  }
  return <div ref={containerRef} className="map-surface" />
}

function GooglePane({
  paneId,
  apiKey,
  googleReady,
  viewState,
  onPaneViewChange,
  markers,
  boundaries,
  boundaryDraft,
  gpsPoint,
  onMapClick,
  onMapDoubleClick,
  onSelectMarker,
  onSelectBoundary,
}: CommonPaneProps & { apiKey: string; googleReady: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<google.maps.Map | null>(null)
  const viewStateRef = useRef(viewState)
  const overlaysRef = useRef<{
    markers: google.maps.Marker[]
    polygons: google.maps.Polygon[]
    draft: google.maps.Polygon | null
    gpsDot: google.maps.Circle | null
  }>({ markers: [], polygons: [], draft: null, gpsDot: null })
  const isSyncingRef = useRef(false)
  const isInteractingRef = useRef(false)
  const onMapClickRef = useRef(onMapClick)
  const onMapDoubleClickRef = useRef(onMapDoubleClick)
  const onPaneViewChangeRef = useRef(onPaneViewChange)

  useEffect(() => {
    viewStateRef.current = viewState
  }, [viewState])

  useEffect(() => {
    onMapClickRef.current = onMapClick
    onMapDoubleClickRef.current = onMapDoubleClick
    onPaneViewChangeRef.current = onPaneViewChange
  }, [onMapClick, onMapDoubleClick, onPaneViewChange])

  useEffect(() => {
    if (!apiKey || !googleReady || !containerRef.current || mapRef.current) return
    Promise.resolve().then(() => {
      const maps = window.google.maps
      const map = new maps.Map(containerRef.current as HTMLDivElement, {
        center: viewStateRef.current.center,
        zoom: viewStateRef.current.zoom,
        mapTypeId: maps.MapTypeId.SATELLITE,
        gestureHandling: 'greedy',
        disableDoubleClickZoom: true,
      })
      mapRef.current = map
      map.addListener('dragstart', () => {
        isInteractingRef.current = true
      })
      map.addListener('zoom_changed', () => {
        if (!isSyncingRef.current) {
          isInteractingRef.current = true
        }
      })
      map.addListener('idle', () => {
        if (isSyncingRef.current) {
          isSyncingRef.current = false
          return
        }
        isInteractingRef.current = false
        const center = map.getCenter()
        if (!center) return
        const next = {
          center: { lat: center.lat(), lng: center.lng() },
          zoom: map.getZoom() ?? viewState.zoom,
        }
        onPaneViewChangeRef.current(paneId, next)
      })
      map.addListener('click', (event: google.maps.MapMouseEvent) => {
        if (!event.latLng) return
        onMapClickRef.current(event.latLng.lat(), event.latLng.lng())
      })
      map.addListener('dblclick', () => onMapDoubleClickRef.current())
    })
  }, [
    paneId,
    apiKey,
    googleReady,
  ])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (isInteractingRef.current) return
    const center = map.getCenter()
    const currentView: MapViewState = {
      center: {
        lat: center?.lat() ?? viewState.center.lat,
        lng: center?.lng() ?? viewState.center.lng,
      },
      zoom: map.getZoom() ?? viewState.zoom,
    }
    if (isViewStateSimilar(currentView, viewState)) return
    isSyncingRef.current = true
    map.setCenter(viewState.center)
    map.setZoom(viewState.zoom)
  }, [viewState])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    overlaysRef.current.markers.forEach((marker) => marker.setMap(null))
    overlaysRef.current.markers = markers.map((item) => {
      const marker = new google.maps.Marker({
        map,
        position: { lat: item.lat, lng: item.lng },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: '#ea4335',
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      })
      marker.addListener('click', () => onSelectMarker(item.id))
      return marker
    })
  }, [markers, onSelectMarker])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    overlaysRef.current.polygons.forEach((shape) => shape.setMap(null))
    overlaysRef.current.polygons = boundaries.map((boundary) => {
      const shape = new google.maps.Polygon({
        map,
        paths: boundary.coordinates.map(([lng, lat]) => ({ lat, lng })),
        fillColor: '#2a6af6',
        fillOpacity: 0.2,
        strokeColor: '#2a6af6',
        strokeWeight: 2,
      })
      shape.addListener('click', () => onSelectBoundary(boundary.id))
      return shape
    })

    if (overlaysRef.current.draft) {
      overlaysRef.current.draft.setMap(null)
      overlaysRef.current.draft = null
    }
    if (boundaryDraft.length >= 3) {
      overlaysRef.current.draft = new google.maps.Polygon({
        map,
        paths: boundaryDraft.map(([lng, lat]) => ({ lat, lng })),
        fillColor: '#4f46e5',
        fillOpacity: 0.15,
        strokeColor: '#4f46e5',
        strokeWeight: 2,
      })
    }
  }, [boundaries, boundaryDraft, onSelectBoundary])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (overlaysRef.current.gpsDot) {
      overlaysRef.current.gpsDot.setMap(null)
      overlaysRef.current.gpsDot = null
    }
    if (!gpsPoint) return
    overlaysRef.current.gpsDot = new google.maps.Circle({
      map,
      center: gpsPoint,
      radius: 6,
      fillColor: '#1a73e8',
      fillOpacity: 1,
      strokeColor: '#ffffff',
      strokeOpacity: 1,
      strokeWeight: 2,
    })
  }, [gpsPoint])

  if (!apiKey) {
    return (
      <div className="map-placeholder">
        Missing `VITE_GOOGLE_MAPS_API_KEY` in deployment environment.
      </div>
    )
  }
  return <div ref={containerRef} className="map-surface" />
}

export default App
