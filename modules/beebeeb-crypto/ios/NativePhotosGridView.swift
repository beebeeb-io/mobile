import ExpoModulesCore
import ImageIO
import Photos
import UIKit

private struct NativePhotoGridItem: Hashable {
  let id: String
  let displayName: String?
  let mimeType: String?
  let monthKey: String
  let monthLabel: String
  let thumbnailUri: String?
  let localAssetId: String?
  let placeholderColor: UIColor
  let isVideo: Bool
  let isFromBackup: Bool
}

private struct NativePhotoGridSection {
  let key: String
  let label: String
  var items: [NativePhotoGridItem]
}

public final class NativePhotosGridModule: Module {
  public func definition() -> ModuleDefinition {
    Name("NativePhotosGridView")

    View(NativePhotosGridView.self) {
      Events("onPhotoPress", "onSelectionChange", "onVisiblePhotoIdsChange", "onRefresh", "onZoomChange", "onPerfEvent")

      Prop("items") { (view: NativePhotosGridView, items: [[String: Any]]?) in
        view.setItems(items ?? [])
      }

      Prop("selectedIds") { (view: NativePhotosGridView, ids: [String]?) in
        view.setSelectedIds(Set(ids ?? []))
      }

      Prop("selectionMode") { (view: NativePhotosGridView, enabled: Bool?) in
        view.setSelectionMode(enabled ?? false)
      }

      Prop("refreshing") { (view: NativePhotosGridView, refreshing: Bool?) in
        view.setRefreshing(refreshing ?? false)
      }
    }
  }
}

private final class PhotoGridLayout: UICollectionViewLayout {
  struct Transition {
    let fromColumns: Int
    let toColumns: Int
    let progress: CGFloat
  }

  var currentColumns = 4
  var itemCountsProvider: (() -> [Int])?
  private(set) var prepareCount = 0
  private(set) var attributeRequestCount = 0
  private(set) var attributeProducedCount = 0

  private let headerHeight: CGFloat = 28
  private var transition: Transition?
  private var itemCounts: [Int] = []
  private var layoutWidth: CGFloat = 1
  private var currentSectionStarts: [CGFloat] = []
  private var transitionFromStarts: [CGFloat] = []
  private var transitionToStarts: [CGFloat] = []
  private var contentSize: CGSize = .zero

  func setTransition(from fromColumns: Int, to toColumns: Int, progress: CGFloat) {
    transition = Transition(
      fromColumns: max(1, fromColumns),
      toColumns: max(1, toColumns),
      progress: max(0, min(1, progress))
    )
  }

  func clearTransition() {
    transition = nil
  }

  override var collectionViewContentSize: CGSize {
    contentSize
  }

  override func prepare() {
    super.prepare()
    guard let collectionView else { return }
    prepareCount += 1
    layoutWidth = max(collectionView.bounds.width, 1)
    itemCounts = itemCountsProvider?() ?? []

    let finalHeight: CGFloat
    if let transition {
      transitionFromStarts = sectionStarts(itemCounts: itemCounts, columns: transition.fromColumns, width: layoutWidth)
      transitionToStarts = sectionStarts(itemCounts: itemCounts, columns: transition.toColumns, width: layoutWidth)
      currentSectionStarts = []
      finalHeight = interpolate(
        totalHeight(itemCounts: itemCounts, columns: transition.fromColumns, width: layoutWidth),
        totalHeight(itemCounts: itemCounts, columns: transition.toColumns, width: layoutWidth),
        progress: transition.progress
      )
    } else {
      currentSectionStarts = sectionStarts(itemCounts: itemCounts, columns: currentColumns, width: layoutWidth)
      transitionFromStarts = []
      transitionToStarts = []
      finalHeight = totalHeight(itemCounts: itemCounts, columns: currentColumns, width: layoutWidth)
    }

    contentSize = CGSize(width: layoutWidth, height: max(collectionView.bounds.height, finalHeight))
  }

  override func layoutAttributesForElements(in rect: CGRect) -> [UICollectionViewLayoutAttributes]? {
    attributeRequestCount += 1
    guard !itemCounts.isEmpty else { return [] }
    var attributes: [UICollectionViewLayoutAttributes] = []
    attributes.reserveCapacity(80)

    for section in itemCounts.indices {
      guard sectionIntersects(section: section, rect: rect) else { continue }
      if let header = headerAttributes(section: section), header.frame.intersects(rect) {
        attributes.append(header)
      }
      let range = visibleItemRange(section: section, rect: rect)
      guard !range.isEmpty else { continue }
      for item in range {
        let indexPath = IndexPath(item: item, section: section)
        guard let cell = cellAttributes(indexPath: indexPath), cell.frame.intersects(rect) else { continue }
        attributes.append(cell)
      }
    }
    attributeProducedCount += attributes.count
    return attributes
  }

  func metricsSnapshot() -> [String: Int] {
    [
      "prepareCount": prepareCount,
      "attributeRequestCount": attributeRequestCount,
      "attributeProducedCount": attributeProducedCount
    ]
  }

  override func layoutAttributesForItem(at indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    cellAttributes(indexPath: indexPath)
  }

  override func layoutAttributesForSupplementaryView(
    ofKind elementKind: String,
    at indexPath: IndexPath
  ) -> UICollectionViewLayoutAttributes? {
    guard elementKind == UICollectionView.elementKindSectionHeader else { return nil }
    return headerAttributes(section: indexPath.section)
  }

  override func shouldInvalidateLayout(forBoundsChange newBounds: CGRect) -> Bool {
    guard let collectionView else { return false }
    return abs(collectionView.bounds.width - newBounds.width) > 0.5
  }

  private func sectionStarts(itemCounts: [Int], columns: Int, width: CGFloat) -> [CGFloat] {
    var starts: [CGFloat] = []
    starts.reserveCapacity(itemCounts.count)
    var y: CGFloat = 0
    for count in itemCounts {
      starts.append(y)
      y += sectionHeight(itemCount: count, columns: columns, width: width)
    }
    return starts
  }

  private func sectionHeight(itemCount: Int, columns: Int, width: CGFloat) -> CGFloat {
    let itemSide = width / CGFloat(max(columns, 1))
    let rows = ceil(CGFloat(itemCount) / CGFloat(max(columns, 1)))
    return headerHeight + rows * itemSide
  }

  private func totalHeight(itemCounts: [Int], columns: Int, width: CGFloat) -> CGFloat {
    itemCounts.reduce(CGFloat(0)) { partial, count in
      partial + sectionHeight(itemCount: count, columns: columns, width: width)
    }
  }

  private func itemFrame(
    indexPath: IndexPath,
    itemCounts: [Int],
    sectionStarts: [CGFloat],
    columns: Int,
    width: CGFloat
  ) -> CGRect {
    let safeColumns = max(columns, 1)
    let itemSide = width / CGFloat(safeColumns)
    let row = indexPath.item / safeColumns
    let column = indexPath.item % safeColumns
    let y = sectionStarts[indexPath.section] + headerHeight + CGFloat(row) * itemSide
    return CGRect(
      x: CGFloat(column) * itemSide,
      y: y,
      width: itemSide,
      height: itemSide
    ).insetBy(dx: 1, dy: 1)
  }

  private func headerAttributes(section: Int) -> UICollectionViewLayoutAttributes? {
    guard itemCounts.indices.contains(section) else { return nil }
    let indexPath = IndexPath(item: 0, section: section)
    let attributes = UICollectionViewLayoutAttributes(
      forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader,
      with: indexPath
    )
    if let transition {
      attributes.frame = interpolate(
        CGRect(x: 0, y: transitionFromStarts[section], width: layoutWidth, height: headerHeight),
        CGRect(x: 0, y: transitionToStarts[section], width: layoutWidth, height: headerHeight),
        progress: transition.progress
      )
    } else {
      attributes.frame = CGRect(x: 0, y: currentSectionStarts[section], width: layoutWidth, height: headerHeight)
    }
    attributes.zIndex = 1
    return attributes
  }

  private func cellAttributes(indexPath: IndexPath) -> UICollectionViewLayoutAttributes? {
    guard itemCounts.indices.contains(indexPath.section),
          indexPath.item >= 0,
          indexPath.item < itemCounts[indexPath.section] else { return nil }
    let attributes = UICollectionViewLayoutAttributes(forCellWith: indexPath)
    if let transition {
      attributes.frame = interpolate(
        itemFrame(
          indexPath: indexPath,
          itemCounts: itemCounts,
          sectionStarts: transitionFromStarts,
          columns: transition.fromColumns,
          width: layoutWidth
        ),
        itemFrame(
          indexPath: indexPath,
          itemCounts: itemCounts,
          sectionStarts: transitionToStarts,
          columns: transition.toColumns,
          width: layoutWidth
        ),
        progress: transition.progress
      )
    } else {
      attributes.frame = itemFrame(
        indexPath: indexPath,
        itemCounts: itemCounts,
        sectionStarts: currentSectionStarts,
        columns: currentColumns,
        width: layoutWidth
      )
    }
    return attributes
  }

  private func visibleItemRange(section: Int, rect: CGRect) -> Range<Int> {
    guard itemCounts.indices.contains(section), itemCounts[section] > 0 else { return 0..<0 }
    if let transition {
      let first = roughVisibleItemRange(
        section: section,
        rect: rect,
        sectionStarts: transitionFromStarts,
        columns: transition.fromColumns
      )
      let second = roughVisibleItemRange(
        section: section,
        rect: rect,
        sectionStarts: transitionToStarts,
        columns: transition.toColumns
      )
      guard !first.isEmpty || !second.isEmpty else { return 0..<0 }
      return min(first.lowerBound, second.lowerBound)..<max(first.upperBound, second.upperBound)
    }
    return roughVisibleItemRange(section: section, rect: rect, sectionStarts: currentSectionStarts, columns: currentColumns)
  }

  private func roughVisibleItemRange(
    section: Int,
    rect: CGRect,
    sectionStarts: [CGFloat],
    columns: Int
  ) -> Range<Int> {
    guard sectionStarts.indices.contains(section), itemCounts.indices.contains(section) else { return 0..<0 }
    let count = itemCounts[section]
    let safeColumns = max(columns, 1)
    let itemSide = layoutWidth / CGFloat(safeColumns)
    let rowCount = Int(ceil(CGFloat(count) / CGFloat(safeColumns)))
    let itemTop = sectionStarts[section] + headerHeight
    let itemBottom = itemTop + CGFloat(rowCount) * itemSide
    guard rect.maxY >= itemTop, rect.minY <= itemBottom else { return 0..<0 }
    let firstRow = max(0, Int(floor((rect.minY - sectionStarts[section] - headerHeight) / itemSide)) - 2)
    let lastRow = min(rowCount - 1, max(0, Int(ceil((rect.maxY - sectionStarts[section] - headerHeight) / itemSide)) + 2))
    let lower = min(count, max(0, firstRow * safeColumns))
    let upper = min(count, max(lower, (lastRow + 1) * safeColumns))
    return lower..<upper
  }

  private func sectionIntersects(section: Int, rect: CGRect) -> Bool {
    if let transition {
      return sectionFrame(section: section, starts: transitionFromStarts, columns: transition.fromColumns).intersects(rect)
        || sectionFrame(section: section, starts: transitionToStarts, columns: transition.toColumns).intersects(rect)
    }
    return sectionFrame(section: section, starts: currentSectionStarts, columns: currentColumns).intersects(rect)
  }

  private func sectionFrame(section: Int, starts: [CGFloat], columns: Int) -> CGRect {
    guard starts.indices.contains(section), itemCounts.indices.contains(section) else { return .null }
    return CGRect(
      x: 0,
      y: starts[section],
      width: layoutWidth,
      height: sectionHeight(itemCount: itemCounts[section], columns: columns, width: layoutWidth)
    )
  }

  private func interpolate(_ start: CGRect, _ end: CGRect, progress: CGFloat) -> CGRect {
    CGRect(
      x: interpolate(start.minX, end.minX, progress: progress),
      y: interpolate(start.minY, end.minY, progress: progress),
      width: interpolate(start.width, end.width, progress: progress),
      height: interpolate(start.height, end.height, progress: progress)
    )
  }

  private func interpolate(_ start: CGFloat, _ end: CGFloat, progress: CGFloat) -> CGFloat {
    start + (end - start) * progress
  }
}

public final class NativePhotosGridView: ExpoView {
  let onPhotoPress = EventDispatcher()
  let onSelectionChange = EventDispatcher()
  let onVisiblePhotoIdsChange = EventDispatcher()
  let onRefresh = EventDispatcher()
  let onZoomChange = EventDispatcher()
  let onPerfEvent = EventDispatcher()

  private enum ElementKind {
    static let header = "beebeeb.photo-grid.header"
  }

  private let columns: [Int] = [2, 4, 7, 12]
  private var currentColumns = 4
  private var pinchStartColumns = 4
  private var pinchTargetColumns = 4
  private var selectionMode = false
  private var selectedIds = Set<String>()
  private var sections: [NativePhotoGridSection] = []
  private var indexPathById: [String: IndexPath] = [:]
  private var itemSignature = ""
  private var layoutSignature = ""
  private var visibleIds = Set<String>()
  private var imageRequests: [String: PHImageRequestID] = [:]
  private let photoCachingManager = PHCachingImageManager()
  private var preheatedLocalAssetIds = Set<String>()
  private weak var selectionDragRecognizer: UIPanGestureRecognizer?
  private var visibleDispatchWorkItem: DispatchWorkItem?
  private var preheatWorkItem: DispatchWorkItem?
  private var selectionDispatchWorkItem: DispatchWorkItem?
  private var isScrollingWithMomentum = false
  private var needsVisibleReconfigureAfterScroll = false
  private var needsScrollSideEffectsAfterScroll = false
  private var isPinchingGrid = false
  private var autoscrollLink: CADisplayLink?
  private var autoscrollVelocity: CGFloat = 0
  private var lastViewportDragPoint: CGPoint?
  private var lastSelectionDragIndexPath: IndexPath?
  private var lastAutoscrollTimestamp: CFTimeInterval = 0
  private var pinchStartContentOffset: CGPoint = .zero
  private var pinchAnchor: CGPoint = .zero
  private var lastLivePinchProgress: CGFloat = -1
  private var lastLivePinchTargetColumns = 4
  private var pinchDisplayLink: CADisplayLink?
  private var pendingPinchTargetColumns: Int?
  private var pendingPinchProgress: CGFloat = 0
  private var pendingPinchAnchor: CGPoint = .zero
  private var pendingPinchAnchorRatio: CGFloat = 0
  private var pinchChangedCount = 0
  private var pinchSkippedCount = 0
  private var pinchAppliedFrameCount = 0
  private var pinchLayoutTotalMs: Double = 0
  private var pinchLayoutMaxMs: Double = 0
  private var pinchLayoutMetricsStart: [String: Int] = [:]
  private var pinchThumbnailMetricsStart = PhotoGridCell.Metrics()

  private lazy var gridLayout: PhotoGridLayout = {
    let layout = PhotoGridLayout()
    layout.currentColumns = currentColumns
    layout.itemCountsProvider = { [weak self] in
      self?.sections.map(\.items.count) ?? []
    }
    return layout
  }()

  private lazy var collectionView: UICollectionView = {
    let view = UICollectionView(frame: .zero, collectionViewLayout: gridLayout)
    view.backgroundColor = .clear
    view.clipsToBounds = true
    view.alwaysBounceVertical = true
    view.decelerationRate = .normal
    view.delaysContentTouches = false
    view.allowsMultipleSelection = true
    view.dataSource = self
    view.prefetchDataSource = self
    view.delegate = self
    view.register(PhotoGridCell.self, forCellWithReuseIdentifier: PhotoGridCell.reuseIdentifier)
    view.register(
      PhotoGridHeaderView.self,
      forSupplementaryViewOfKind: UICollectionView.elementKindSectionHeader,
      withReuseIdentifier: PhotoGridHeaderView.reuseIdentifier
    )
    let refresh = UIRefreshControl()
    refresh.addTarget(self, action: #selector(handleRefresh), for: .valueChanged)
    view.refreshControl = refresh
    return view
  }()

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    addSubview(collectionView)

    let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handlePinch(_:)))
    collectionView.addGestureRecognizer(pinch)

    let longPress = UILongPressGestureRecognizer(target: self, action: #selector(handleLongPress(_:)))
    longPress.minimumPressDuration = 0.24
    collectionView.addGestureRecognizer(longPress)

    let drag = UIPanGestureRecognizer(target: self, action: #selector(handleSelectionDrag(_:)))
    drag.minimumNumberOfTouches = 1
    drag.maximumNumberOfTouches = 1
    drag.delegate = self
    drag.cancelsTouchesInView = false
    selectionDragRecognizer = drag
    collectionView.addGestureRecognizer(drag)
  }

  deinit {
    visibleDispatchWorkItem?.cancel()
    preheatWorkItem?.cancel()
    selectionDispatchWorkItem?.cancel()
    autoscrollLink?.invalidate()
    pinchDisplayLink?.invalidate()
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    collectionView.frame = bounds
  }

  func setItems(_ rawItems: [[String: Any]]) {
    let nextItems = rawItems.compactMap(Self.parseItem)
    let nextSignature = Self.signature(for: nextItems)
    if nextSignature == itemSignature {
      return
    }
    let nextLayoutSignature = Self.layoutSignature(for: nextItems)

    let previousSelectedIds = selectedIds
    let previousSelectionMode = selectionMode
    var grouped: [NativePhotoGridSection] = []
    var sectionIndex: [String: Int] = [:]

    for item in nextItems {
      if let index = sectionIndex[item.monthKey] {
        grouped[index].items.append(item)
      } else {
        sectionIndex[item.monthKey] = grouped.count
        grouped.append(NativePhotoGridSection(key: item.monthKey, label: item.monthLabel, items: [item]))
      }
    }

    sections = grouped
    var nextIndexPathById: [String: IndexPath] = [:]
    for sectionIndex in grouped.indices {
      for itemIndex in grouped[sectionIndex].items.indices {
        nextIndexPathById[grouped[sectionIndex].items[itemIndex].id] = IndexPath(item: itemIndex, section: sectionIndex)
      }
    }
    indexPathById = nextIndexPathById
    selectedIds = selectedIds.intersection(Set(nextItems.map(\.id)))
    if selectedIds.isEmpty {
      selectionMode = false
    }
    itemSignature = nextSignature
    let layoutChanged = nextLayoutSignature != layoutSignature
    if nextLayoutSignature == layoutSignature {
      if isScrollingWithMomentum {
        needsVisibleReconfigureAfterScroll = true
      } else {
        reconfigureVisibleCells()
      }
    } else {
      layoutSignature = nextLayoutSignature
      collectionView.reloadData()
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        self.collectionView.layoutIfNeeded()
        self.dispatchVisibleIds()
        self.updatePhotoKitPreheat()
      }
    }
    if layoutChanged || selectedIds != previousSelectedIds || selectionMode != previousSelectionMode {
      applySelectedState()
    }
    if isScrollingWithMomentum {
      needsScrollSideEffectsAfterScroll = true
    } else {
      dispatchVisibleIds()
      updatePhotoKitPreheat()
    }
    if selectedIds != previousSelectedIds || selectionMode != previousSelectionMode {
      dispatchSelectionChange()
    }
  }

  func setSelectedIds(_ ids: Set<String>) {
    let nextSelectionMode = !ids.isEmpty
    guard ids != selectedIds || nextSelectionMode != selectionMode else { return }
    selectedIds = ids
    selectionMode = nextSelectionMode
    applySelectedState()
  }

  func setSelectionMode(_ enabled: Bool) {
    guard enabled != selectionMode || (!enabled && !selectedIds.isEmpty) else { return }
    selectionMode = enabled
    if !enabled {
      selectedIds.removeAll()
    }
    applySelectedState()
  }

  func setRefreshing(_ refreshing: Bool) {
    if refreshing {
      if collectionView.refreshControl?.isRefreshing == false {
        collectionView.refreshControl?.beginRefreshing()
      }
    } else {
      collectionView.refreshControl?.endRefreshing()
    }
  }

  @objc private func handleRefresh() {
    onRefresh()
  }

  @objc private func handlePinch(_ recognizer: UIPinchGestureRecognizer) {
    switch recognizer.state {
    case .began:
      pinchStartColumns = currentColumns
      pinchTargetColumns = currentColumns
      resetPinchMetrics()
      lastLivePinchProgress = -1
      lastLivePinchTargetColumns = currentColumns
      pinchStartContentOffset = collectionView.contentOffset
      pinchAnchor = recognizer.location(in: self)
      isPinchingGrid = true
      visibleDispatchWorkItem?.cancel()
      visibleDispatchWorkItem = nil
      preheatWorkItem?.cancel()
      preheatWorkItem = nil
      collectionView.layer.zPosition = 10
    case .changed:
      applyLivePinch(scale: recognizer.scale, anchor: recognizer.location(in: self))
    case .ended:
      let next = columnsFor(scale: recognizer.scale, start: pinchStartColumns)
      let anchor = recognizer.location(in: self)
      finishLivePinch(columns: next, anchor: anchor)
    case .cancelled, .failed:
      cancelLivePinch()
    default:
      break
    }
  }

  @objc private func handleLongPress(_ recognizer: UILongPressGestureRecognizer) {
    guard recognizer.state == .began else { return }
    let point = recognizer.location(in: collectionView)
    guard let indexPath = collectionView.indexPathForItem(at: point),
          let item = item(at: indexPath) else { return }
    selectionMode = true
    selectedIds = [item.id]
    lastSelectionDragIndexPath = indexPath
    applySelectedState()
    dispatchSelectionChange()
  }

  @objc private func handleSelectionDrag(_ recognizer: UIPanGestureRecognizer) {
    guard selectionMode else { return }
    let contentPoint = recognizer.location(in: collectionView)
    let viewportPoint = recognizer.location(in: self)
    lastViewportDragPoint = viewportPoint

    switch recognizer.state {
    case .began:
      selectDragPath(to: contentPoint)
      updateAutoscroll(viewportPoint: viewportPoint)
    case .changed:
      selectDragPath(to: contentPoint)
      updateAutoscroll(viewportPoint: viewportPoint)
    default:
      stopAutoscroll()
      lastSelectionDragIndexPath = nil
      dispatchSelectionChange()
    }
  }

  private func selectDragPath(to point: CGPoint) {
    guard let indexPath = selectableIndexPath(at: point) else { return }
    if let previous = lastSelectionDragIndexPath {
      selectContiguousRange(from: previous, to: indexPath)
    } else {
      selectItem(at: indexPath)
    }
    lastSelectionDragIndexPath = indexPath
  }

  @discardableResult
  private func selectItem(at indexPath: IndexPath) -> Bool {
    guard let item = item(at: indexPath),
          !selectedIds.contains(item.id) else { return false }
    selectedIds.insert(item.id)
    collectionView.selectItem(at: indexPath, animated: false, scrollPosition: [])
    if let cell = collectionView.cellForItem(at: indexPath) as? PhotoGridCell {
      cell.setSelectionMode(true, selected: true)
    }
    return true
  }

  private func selectContiguousRange(from start: IndexPath, to end: IndexPath) {
    guard let startIndex = flatItemIndex(for: start),
          let endIndex = flatItemIndex(for: end) else {
      if selectItem(at: end) {
        scheduleSelectionChange()
      }
      return
    }

    var changed = false
    for flatIndex in min(startIndex, endIndex)...max(startIndex, endIndex) {
      guard let indexPath = indexPath(forFlatItemIndex: flatIndex) else { continue }
      changed = selectItem(at: indexPath) || changed
    }
    if changed {
      scheduleSelectionChange()
    }
  }

  private func selectableIndexPath(at point: CGPoint) -> IndexPath? {
    guard !collectionView.bounds.isEmpty, collectionView.contentSize.height > 0 else { return nil }

    let minX = collectionView.bounds.minX + 1
    let maxX = collectionView.bounds.maxX - 1
    let minY = -collectionView.adjustedContentInset.top + 1
    let maxY = max(minY, collectionView.contentSize.height + collectionView.adjustedContentInset.bottom - 1)
    let clampedPoint = CGPoint(
      x: min(maxX, max(minX, point.x)),
      y: min(maxY, max(minY, point.y))
    )

    if let indexPath = collectionView.indexPathForItem(at: clampedPoint) {
      return indexPath
    }

    let rowProbe = CGRect(
      x: collectionView.bounds.minX,
      y: clampedPoint.y - 8,
      width: collectionView.bounds.width,
      height: 16
    )
    let attributes = (collectionView.collectionViewLayout.layoutAttributesForElements(in: rowProbe) ?? [])
      .filter { $0.representedElementCategory == .cell }
    return attributes.min { lhs, rhs in
      abs(lhs.center.x - clampedPoint.x) < abs(rhs.center.x - clampedPoint.x)
    }?.indexPath
  }

  private func flatItemIndex(for indexPath: IndexPath) -> Int? {
    guard sections.indices.contains(indexPath.section),
          sections[indexPath.section].items.indices.contains(indexPath.item) else {
      return nil
    }
    return sections[..<indexPath.section].reduce(0) { $0 + $1.items.count } + indexPath.item
  }

  private func indexPath(forFlatItemIndex flatIndex: Int) -> IndexPath? {
    guard flatIndex >= 0 else { return nil }
    var offset = flatIndex
    for sectionIndex in sections.indices {
      let itemCount = sections[sectionIndex].items.count
      if offset < itemCount {
        return IndexPath(item: offset, section: sectionIndex)
      }
      offset -= itemCount
    }
    return nil
  }

  private func updateAutoscroll(viewportPoint: CGPoint) {
    let edge: CGFloat = 112
    let maxVelocity: CGFloat = 420
    let minY = collectionView.frame.minY + collectionView.adjustedContentInset.top
    let maxY = collectionView.frame.maxY - collectionView.adjustedContentInset.bottom
    if viewportPoint.y < minY + edge {
      let pressure = min(1, max(0, (minY + edge - viewportPoint.y) / edge))
      autoscrollVelocity = -maxVelocity * pressure * pressure
    } else if viewportPoint.y > maxY - edge {
      let pressure = min(1, max(0, (viewportPoint.y - (maxY - edge)) / edge))
      autoscrollVelocity = maxVelocity * pressure * pressure
    } else {
      autoscrollVelocity = 0
    }

    if abs(autoscrollVelocity) > 1 {
      if autoscrollLink == nil {
        autoscrollLink = CADisplayLink(target: self, selector: #selector(handleAutoscroll(_:)))
        lastAutoscrollTimestamp = 0
        autoscrollLink?.add(to: .main, forMode: .common)
      }
    } else {
      stopAutoscroll()
    }
  }

  @objc private func handleAutoscroll(_ link: CADisplayLink) {
    guard abs(autoscrollVelocity) > 1 else {
      stopAutoscroll()
      return
    }
    let elapsed: CGFloat
    if lastAutoscrollTimestamp > 0 {
      elapsed = CGFloat(min(1.0 / 30.0, max(1.0 / 120.0, link.timestamp - lastAutoscrollTimestamp)))
    } else {
      elapsed = CGFloat(link.duration)
    }
    lastAutoscrollTimestamp = link.timestamp

    let minY = -collectionView.adjustedContentInset.top
    let maxY = max(minY, collectionView.contentSize.height - collectionView.bounds.height + collectionView.adjustedContentInset.bottom)
    let nextY = min(maxY, max(minY, collectionView.contentOffset.y + autoscrollVelocity * elapsed))
    guard nextY != collectionView.contentOffset.y else { return }

    collectionView.setContentOffset(CGPoint(x: collectionView.contentOffset.x, y: nextY), animated: false)
    if let viewportPoint = lastViewportDragPoint {
      let contentPoint = collectionView.convert(viewportPoint, from: self)
      selectDragPath(to: contentPoint)
    }
    scheduleVisibleIdsDispatch()
    schedulePhotoKitPreheat()
  }

  private func stopAutoscroll() {
    autoscrollLink?.invalidate()
    autoscrollLink = nil
    autoscrollVelocity = 0
    lastAutoscrollTimestamp = 0
  }

  private func applyLivePinch(scale: CGFloat, anchor: CGPoint) {
    pinchChangedCount += 1
    let oldContentHeight = max(collectionView.contentSize.height, 1)
    let anchorAbsoluteY = collectionView.contentOffset.y + anchor.y
    let anchorRatio = anchorAbsoluteY / oldContentHeight
    let target = liveTargetColumns(for: scale, start: pinchStartColumns)
    let progress = pinchProgress(for: scale, start: pinchStartColumns, target: target)
    if target == lastLivePinchTargetColumns, abs(progress - lastLivePinchProgress) < 0.012 {
      pinchSkippedCount += 1
      return
    }
    lastLivePinchTargetColumns = target
    lastLivePinchProgress = progress
    pinchTargetColumns = target
    pendingPinchTargetColumns = target
    pendingPinchProgress = progress
    pendingPinchAnchor = anchor
    pendingPinchAnchorRatio = anchorRatio
    startPinchDisplayLinkIfNeeded()
  }

  private func resetPinchMetrics() {
    pinchChangedCount = 0
    pinchSkippedCount = 0
    pinchAppliedFrameCount = 0
    pinchLayoutTotalMs = 0
    pinchLayoutMaxMs = 0
    pinchLayoutMetricsStart = gridLayout.metricsSnapshot()
    pinchThumbnailMetricsStart = PhotoGridCell.metricsSnapshot()
  }

  private func startPinchDisplayLinkIfNeeded() {
    guard pinchDisplayLink == nil else { return }
    let link = CADisplayLink(target: self, selector: #selector(handlePinchDisplayLink(_:)))
    link.add(to: .main, forMode: .common)
    pinchDisplayLink = link
  }

  @objc private func handlePinchDisplayLink(_ link: CADisplayLink) {
    flushPendingPinchLayout()
  }

  private func flushPendingPinchLayout() {
    guard let target = pendingPinchTargetColumns else { return }
    let progress = pendingPinchProgress
    let anchor = pendingPinchAnchor
    let anchorRatio = pendingPinchAnchorRatio
    pendingPinchTargetColumns = nil
    let started = CACurrentMediaTime()
    gridLayout.setTransition(from: pinchStartColumns, to: target, progress: progress)
    gridLayout.invalidateLayout()
    collectionView.layoutIfNeeded()
    keepAnchor(anchor, atContentRatio: anchorRatio)
    let elapsedMs = (CACurrentMediaTime() - started) * 1000
    pinchAppliedFrameCount += 1
    pinchLayoutTotalMs += elapsedMs
    pinchLayoutMaxMs = max(pinchLayoutMaxMs, elapsedMs)
  }

  private func finishLivePinch(columns: Int, anchor: CGPoint) {
    collectionView.layer.zPosition = 0
    flushPendingPinchLayout()
    pinchDisplayLink?.invalidate()
    pinchDisplayLink = nil
    pendingPinchTargetColumns = nil
    lastLivePinchProgress = -1
    lastLivePinchTargetColumns = columns
    isPinchingGrid = false
    relayout(columns: columns, anchor: anchor, animated: true)
    emitPinchPerfEvent(result: "ended", columns: columns)
  }

  private func cancelLivePinch() {
    collectionView.layer.zPosition = 0
    pinchDisplayLink?.invalidate()
    pinchDisplayLink = nil
    pendingPinchTargetColumns = nil
    lastLivePinchProgress = -1
    lastLivePinchTargetColumns = currentColumns
    isPinchingGrid = false
    relayout(columns: currentColumns, anchor: pinchAnchor, animated: true)
    emitPinchPerfEvent(result: "cancelled", columns: currentColumns)
  }

  private func emitPinchPerfEvent(result: String, columns: Int) {
    let layoutMetrics = gridLayout.metricsSnapshot()
    let thumbnailMetrics = PhotoGridCell.metricsSnapshot()
    let thumbnailDelta = thumbnailMetrics.delta(from: pinchThumbnailMetricsStart)
    let frames = max(pinchAppliedFrameCount, 1)
    onPerfEvent([
      "type": "pinch",
      "result": result,
      "columns": columns,
      "changes": pinchChangedCount,
      "skipped": pinchSkippedCount,
      "frames": pinchAppliedFrameCount,
      "layoutAvgMs": pinchLayoutTotalMs / Double(frames),
      "layoutMaxMs": pinchLayoutMaxMs,
      "layoutPrepares": layoutMetrics["prepareCount", default: 0] - pinchLayoutMetricsStart["prepareCount", default: 0],
      "attributeRequests": layoutMetrics["attributeRequestCount", default: 0] - pinchLayoutMetricsStart["attributeRequestCount", default: 0],
      "attributeProduced": layoutMetrics["attributeProducedCount", default: 0] - pinchLayoutMetricsStart["attributeProducedCount", default: 0],
      "sourceCacheHits": thumbnailDelta.sourceCacheHits,
      "fileCacheHits": thumbnailDelta.fileCacheHits,
      "fileLoadStarts": thumbnailDelta.fileLoadStarts,
      "localAssetStarts": thumbnailDelta.localAssetStarts
    ])
  }

  private func relayout(columns: Int, anchor: CGPoint, animated: Bool = false) {
    let oldContentHeight = max(collectionView.contentSize.height, 1)
    let anchorAbsoluteY = collectionView.contentOffset.y + anchor.y
    let anchorRatio = anchorAbsoluteY / oldContentHeight
    currentColumns = columns
    gridLayout.currentColumns = columns
    gridLayout.clearTransition()
    let updates = {
      self.gridLayout.invalidateLayout()
      self.collectionView.layoutIfNeeded()
      self.keepAnchor(anchor, atContentRatio: anchorRatio)
    }
    if animated {
      UIView.animate(withDuration: 0.22, delay: 0, options: [.curveEaseOut, .allowUserInteraction], animations: updates)
    } else {
      updates()
    }
    onZoomChange(["columns": currentColumns])
    reconfigureVisibleCells()
    dispatchVisibleIds()
    updatePhotoKitPreheat()
  }

  private func columnsFor(scale: CGFloat, start: Int) -> Int {
    guard let startIndex = columns.firstIndex(of: start) else { return start }
    var nextIndex = startIndex
    if scale < 0.48 {
      nextIndex += 3
    } else if scale < 0.68 {
      nextIndex += 2
    } else if scale < 0.9 {
      nextIndex += 1
    } else if scale > 2.1 {
      nextIndex -= 3
    } else if scale > 1.55 {
      nextIndex -= 2
    } else if scale > 1.12 {
      nextIndex -= 1
    }
    return columns[min(columns.count - 1, max(0, nextIndex))]
  }

  private func liveTargetColumns(for scale: CGFloat, start: Int) -> Int {
    guard scale != 1,
          let startIndex = columns.firstIndex(of: start) else { return start }
    let final = columnsFor(scale: scale, start: start)
    if final != start {
      return final
    }
    if scale < 1 {
      return columns[min(columns.count - 1, startIndex + 1)]
    }
    return columns[max(0, startIndex - 1)]
  }

  private func pinchProgress(for scale: CGFloat, start: Int, target: Int) -> CGFloat {
    guard target != start,
          let startIndex = columns.firstIndex(of: start),
          let targetIndex = columns.firstIndex(of: target) else { return 0 }
    if targetIndex > startIndex {
      let threshold = targetIndex - startIndex >= 3 ? 0.48 : targetIndex - startIndex == 2 ? 0.68 : 0.82
      return max(0, min(1, (1 - scale) / (1 - threshold)))
    }
    let threshold = startIndex - targetIndex >= 3 ? 2.1 : startIndex - targetIndex == 2 ? 1.55 : 1.28
    return max(0, min(1, (scale - 1) / (threshold - 1)))
  }

  private func keepAnchor(_ anchor: CGPoint, atContentRatio anchorRatio: CGFloat) {
    let newContentHeight = max(collectionView.contentSize.height, 1)
    let nextY = (newContentHeight * anchorRatio) - anchor.y
    let minY = -collectionView.adjustedContentInset.top
    let maxY = max(minY, collectionView.contentSize.height - collectionView.bounds.height + collectionView.adjustedContentInset.bottom)
    collectionView.contentOffset.y = min(maxY, max(minY, nextY))
  }

  private func item(at indexPath: IndexPath) -> NativePhotoGridItem? {
    guard sections.indices.contains(indexPath.section),
          sections[indexPath.section].items.indices.contains(indexPath.item) else {
      return nil
    }
    return sections[indexPath.section].items[indexPath.item]
  }

  private func reconfigureVisibleCells() {
    for cell in collectionView.visibleCells {
      guard let photoCell = cell as? PhotoGridCell,
            let indexPath = collectionView.indexPath(for: cell),
            let item = item(at: indexPath) else { continue }
      photoCell.configure(item: item, columns: currentColumns, imageManager: photoCachingManager)
      photoCell.setSelectionMode(selectionMode, selected: selectedIds.contains(item.id))
    }
  }

  private func applySelectedState() {
    collectionView.allowsMultipleSelection = true
    let wantedIndexPaths = Set(selectedIds.compactMap { indexPathById[$0] })
    let currentIndexPaths = Set(collectionView.indexPathsForSelectedItems ?? [])
    for indexPath in currentIndexPaths.subtracting(wantedIndexPaths) {
      collectionView.deselectItem(at: indexPath, animated: false)
    }
    for indexPath in wantedIndexPaths.subtracting(currentIndexPaths) {
      collectionView.selectItem(at: indexPath, animated: false, scrollPosition: [])
    }
    collectionView.visibleCells.compactMap { $0 as? PhotoGridCell }.forEach { cell in
      guard let indexPath = collectionView.indexPath(for: cell),
            let item = item(at: indexPath) else { return }
      cell.setSelectionMode(selectionMode, selected: selectedIds.contains(item.id))
    }
  }

  private func dispatchSelectionChange() {
    selectionDispatchWorkItem?.cancel()
    selectionDispatchWorkItem = nil
    onSelectionChange([
      "selectedIds": Array(selectedIds).sorted(),
      "selectionMode": selectionMode && !selectedIds.isEmpty
    ])
  }

  private func scheduleSelectionChange() {
    guard selectionDispatchWorkItem == nil else { return }
    let workItem = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.selectionDispatchWorkItem = nil
      self.dispatchSelectionChange()
    }
    selectionDispatchWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.06, execute: workItem)
  }

  private func dispatchVisibleIds() {
    let next = Set(collectionView.indexPathsForVisibleItems.compactMap { item(at: $0)?.id })
    guard next != visibleIds else { return }
    visibleIds = next
    onVisiblePhotoIdsChange(["ids": Array(next).sorted()])
  }

  private func scheduleVisibleIdsDispatch() {
    guard visibleDispatchWorkItem == nil else { return }
    let workItem = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.visibleDispatchWorkItem = nil
      self.dispatchVisibleIds()
    }
    visibleDispatchWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.16, execute: workItem)
  }

  private func updatePhotoKitPreheat() {
    guard !collectionView.bounds.isEmpty else { return }
    let preheatRect = collectionView.bounds.insetBy(dx: 0, dy: -collectionView.bounds.height * 1.5)
    let attributes = collectionView.collectionViewLayout.layoutAttributesForElements(in: preheatRect) ?? []
    let nextIds = Set(attributes.compactMap { item(at: $0.indexPath)?.localAssetId })
    guard nextIds != preheatedLocalAssetIds else { return }

    let targetSize = CGSize(
      width: max(collectionView.bounds.width / CGFloat(max(currentColumns, 1)), 160) * UIScreen.main.scale,
      height: max(collectionView.bounds.width / CGFloat(max(currentColumns, 1)), 160) * UIScreen.main.scale
    )
    let startIds = Array(nextIds.subtracting(preheatedLocalAssetIds))
    let stopIds = Array(preheatedLocalAssetIds.subtracting(nextIds))
    if !startIds.isEmpty {
      let assets = PHAsset.fetchAssets(withLocalIdentifiers: startIds, options: nil)
      photoCachingManager.startCachingImages(for: assets.objects(), targetSize: targetSize, contentMode: .aspectFill, options: nil)
    }
    if !stopIds.isEmpty {
      let assets = PHAsset.fetchAssets(withLocalIdentifiers: stopIds, options: nil)
      photoCachingManager.stopCachingImages(for: assets.objects(), targetSize: targetSize, contentMode: .aspectFill, options: nil)
    }
    preheatedLocalAssetIds = nextIds
  }

  private func schedulePhotoKitPreheat() {
    guard preheatWorkItem == nil else { return }
    let workItem = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.preheatWorkItem = nil
      self.updatePhotoKitPreheat()
    }
    preheatWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.24, execute: workItem)
  }

  private func flushScrollSideEffects() {
    isScrollingWithMomentum = false
    visibleDispatchWorkItem?.cancel()
    visibleDispatchWorkItem = nil
    preheatWorkItem?.cancel()
    preheatWorkItem = nil
    if needsVisibleReconfigureAfterScroll {
      needsVisibleReconfigureAfterScroll = false
      reconfigureVisibleCells()
    }
    needsScrollSideEffectsAfterScroll = false
    dispatchVisibleIds()
    updatePhotoKitPreheat()
  }

  private static func parseItem(_ raw: [String: Any]) -> NativePhotoGridItem? {
    guard let id = raw["id"] as? String,
          let monthKey = raw["monthKey"] as? String,
          let monthLabel = raw["monthLabel"] as? String else {
      return nil
    }
    return NativePhotoGridItem(
      id: id,
      displayName: raw["displayName"] as? String,
      mimeType: raw["mimeType"] as? String,
      monthKey: monthKey,
      monthLabel: monthLabel,
      thumbnailUri: raw["thumbnailUri"] as? String,
      localAssetId: raw["localAssetId"] as? String,
      placeholderColor: UIColor(hexString: raw["placeholderColor"] as? String) ?? UIColor(white: 0.82, alpha: 1),
      isVideo: raw["isVideo"] as? Bool ?? false,
      isFromBackup: raw["isFromBackup"] as? Bool ?? false
    )
  }

  private static func signature(for items: [NativePhotoGridItem]) -> String {
    items.map { item in
      [
        item.id,
        item.displayName ?? "",
        item.mimeType ?? "",
        item.monthKey,
        item.monthLabel,
        item.thumbnailUri ?? "",
        item.localAssetId ?? "",
        item.isVideo ? "1" : "0",
        item.isFromBackup ? "1" : "0"
      ].joined(separator: "\u{1f}")
    }.joined(separator: "\u{1e}")
  }

  private static func layoutSignature(for items: [NativePhotoGridItem]) -> String {
    items.map { item in
      [
        item.id,
        item.monthKey,
        item.monthLabel
      ].joined(separator: "\u{1f}")
    }.joined(separator: "\u{1e}")
  }
}

extension NativePhotosGridView: UICollectionViewDataSource, UICollectionViewDelegate {
  public func numberOfSections(in collectionView: UICollectionView) -> Int {
    sections.count
  }

  public func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    sections[section].items.count
  }

  public func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: PhotoGridCell.reuseIdentifier, for: indexPath)
    guard let photoCell = cell as? PhotoGridCell, let item = item(at: indexPath) else { return cell }
    photoCell.configure(item: item, columns: currentColumns, imageManager: photoCachingManager)
    photoCell.setSelectionMode(selectionMode, selected: selectedIds.contains(item.id))
    return photoCell
  }

  public func collectionView(
    _ collectionView: UICollectionView,
    viewForSupplementaryElementOfKind kind: String,
    at indexPath: IndexPath
  ) -> UICollectionReusableView {
    let view = collectionView.dequeueReusableSupplementaryView(
      ofKind: kind,
      withReuseIdentifier: PhotoGridHeaderView.reuseIdentifier,
      for: indexPath
    )
    guard let header = view as? PhotoGridHeaderView, sections.indices.contains(indexPath.section) else {
      return view
    }
    let section = sections[indexPath.section]
    header.configure(label: section.label, count: section.items.count)
    return header
  }

  public func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    guard let item = item(at: indexPath) else { return }
    if selectionMode {
      selectedIds.insert(item.id)
      (collectionView.cellForItem(at: indexPath) as? PhotoGridCell)?.setSelectionMode(true, selected: true)
      dispatchSelectionChange()
    } else {
      collectionView.deselectItem(at: indexPath, animated: false)
      onPhotoPress(["id": item.id])
    }
  }

  public func collectionView(_ collectionView: UICollectionView, didDeselectItemAt indexPath: IndexPath) {
    guard selectionMode, let item = item(at: indexPath) else { return }
    selectedIds.remove(item.id)
    (collectionView.cellForItem(at: indexPath) as? PhotoGridCell)?.setSelectionMode(true, selected: false)
    if selectedIds.isEmpty {
      selectionMode = false
      applySelectedState()
    }
    dispatchSelectionChange()
  }

  public func scrollViewDidScroll(_ scrollView: UIScrollView) {
    if isPinchingGrid {
      needsScrollSideEffectsAfterScroll = true
      scheduleVisibleIdsDispatch()
      preheatWorkItem?.cancel()
      preheatWorkItem = nil
      return
    }
    if scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating {
      needsScrollSideEffectsAfterScroll = true
      scheduleVisibleIdsDispatch()
      preheatWorkItem?.cancel()
      preheatWorkItem = nil
      return
    }
    scheduleVisibleIdsDispatch()
    schedulePhotoKitPreheat()
  }

  public func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
    isScrollingWithMomentum = true
    visibleDispatchWorkItem?.cancel()
    visibleDispatchWorkItem = nil
    preheatWorkItem?.cancel()
    preheatWorkItem = nil
  }

  public func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
    if !decelerate {
      flushScrollSideEffects()
    } else {
      needsScrollSideEffectsAfterScroll = true
    }
  }

  public func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
    flushScrollSideEffects()
  }
}

extension NativePhotosGridView: UICollectionViewDataSourcePrefetching {
  public func collectionView(_ collectionView: UICollectionView, prefetchItemsAt indexPaths: [IndexPath]) {
    let items = indexPaths.compactMap { item(at: $0) }
    PhotoGridCell.prefetch(items: items, columns: currentColumns, containerWidth: collectionView.bounds.width, imageManager: photoCachingManager)
  }

  public func collectionView(_ collectionView: UICollectionView, cancelPrefetchingForItemsAt indexPaths: [IndexPath]) {
    let items = indexPaths.compactMap { item(at: $0) }
    PhotoGridCell.cancelPrefetch(items: items)
  }
}

extension NativePhotosGridView: UIGestureRecognizerDelegate {
  public override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    if gestureRecognizer === selectionDragRecognizer {
      return selectionMode
    }
    return true
  }

  public func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool {
    if gestureRecognizer === selectionDragRecognizer || otherGestureRecognizer === selectionDragRecognizer {
      return otherGestureRecognizer === collectionView.panGestureRecognizer || gestureRecognizer === collectionView.panGestureRecognizer
    }
    return gestureRecognizer is UIPinchGestureRecognizer || otherGestureRecognizer is UIPinchGestureRecognizer
  }
}

private final class PhotoGridCell: UICollectionViewCell {
  struct Metrics {
    var sourceCacheHits = 0
    var fileCacheHits = 0
    var fileLoadStarts = 0
    var localAssetStarts = 0

    func delta(from start: Metrics) -> Metrics {
      Metrics(
        sourceCacheHits: sourceCacheHits - start.sourceCacheHits,
        fileCacheHits: fileCacheHits - start.fileCacheHits,
        fileLoadStarts: fileLoadStarts - start.fileLoadStarts,
        localAssetStarts: localAssetStarts - start.localAssetStarts
      )
    }
  }

  static let reuseIdentifier = "PhotoGridCell"
  private static let fileImageCache = NSCache<NSString, UIImage>()
  private static let sourceImageCache = NSCache<NSString, UIImage>()
  private static var metrics = Metrics()
  private static let localLoadLock = NSLock()
  private static var localLoadOperations: [String: BlockOperation] = [:]
  private static var localLoadCompletions: [String: [(UIImage?) -> Void]] = [:]
  private static let fileLoadQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "io.beebeeb.photo-grid.thumbnail-decode"
    queue.maxConcurrentOperationCount = 4
    queue.qualityOfService = .utility
    return queue
  }()
  private static let localLoadQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "io.beebeeb.photo-grid.photokit"
    queue.maxConcurrentOperationCount = 4
    queue.qualityOfService = .utility
    return queue
  }()

  private let imageView = UIImageView()
  private let originBadge = UIImageView(image: UIImage(systemName: "camera.fill"))
  private let videoBadge = UIImageView(image: UIImage(systemName: "play.fill"))
  private let selectionOverlay = UIView()
  private let selectionBadge = UIView()
  private let selectionCheck = UIImageView(image: UIImage(systemName: "checkmark"))
  private var representedId: String?
  private var representedSourceKey: String?
  private var fileLoadInFlightKey: String?
  private var localLoadInFlightKey: String?

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.clipsToBounds = true

    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    contentView.addSubview(imageView)

    originBadge.tintColor = UIColor(red: 0.09, green: 0.075, blue: 0.055, alpha: 1)
    originBadge.backgroundColor = UIColor(red: 0.965, green: 0.753, blue: 0.227, alpha: 1)
    originBadge.contentMode = .center
    originBadge.layer.cornerRadius = 4
    originBadge.clipsToBounds = true
    contentView.addSubview(originBadge)

    videoBadge.tintColor = .white
    videoBadge.backgroundColor = UIColor.black.withAlphaComponent(0.58)
    videoBadge.contentMode = .center
    videoBadge.layer.borderWidth = 0.5
    videoBadge.layer.borderColor = UIColor.white.withAlphaComponent(0.45).cgColor
    contentView.addSubview(videoBadge)

    selectionOverlay.backgroundColor = UIColor(red: 0.965, green: 0.753, blue: 0.227, alpha: 0.25)
    selectionOverlay.layer.borderWidth = 2
    selectionOverlay.layer.borderColor = UIColor(red: 0.965, green: 0.753, blue: 0.227, alpha: 0.95).cgColor
    selectionOverlay.isUserInteractionEnabled = false
    contentView.addSubview(selectionOverlay)

    selectionBadge.layer.borderWidth = 2
    selectionBadge.layer.cornerRadius = 12
    selectionBadge.clipsToBounds = true
    selectionBadge.isUserInteractionEnabled = false
    contentView.addSubview(selectionBadge)

    selectionCheck.tintColor = UIColor(red: 0.09, green: 0.075, blue: 0.055, alpha: 1)
    selectionCheck.contentMode = .center
    selectionBadge.addSubview(selectionCheck)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    representedId = nil
    representedSourceKey = nil
    fileLoadInFlightKey = nil
    localLoadInFlightKey = nil
    imageView.image = nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    imageView.frame = contentView.bounds
    selectionOverlay.frame = contentView.bounds
    originBadge.frame = CGRect(x: bounds.width - 20, y: bounds.height - 20, width: 16, height: 16)
    videoBadge.frame = CGRect(x: bounds.width - 27, y: 5, width: 22, height: 22)
    videoBadge.layer.cornerRadius = 11
    selectionBadge.frame = CGRect(x: 6, y: 6, width: 24, height: 24)
    selectionCheck.frame = selectionBadge.bounds
  }

  func configure(
    item: NativePhotoGridItem,
    columns: Int,
    imageManager: PHImageManager
  ) {
    representedId = item.id
    contentView.backgroundColor = item.placeholderColor
    let showOverlay = columns <= 4
    originBadge.isHidden = !showOverlay || !item.isFromBackup
    videoBadge.isHidden = !item.isVideo

    let sourceKey = Self.sourceKey(for: item)
    if representedSourceKey != sourceKey {
      fileLoadInFlightKey = nil
      localLoadInFlightKey = nil
      representedSourceKey = sourceKey
      imageView.image = nil
    } else if imageView.image != nil || fileLoadInFlightKey == sourceKey || localLoadInFlightKey == sourceKey {
      return
    }

    if let cached = Self.sourceImageCache.object(forKey: sourceKey as NSString) {
      Self.metrics.sourceCacheHits += 1
      imageView.image = cached
      return
    }

    if let localAssetId = item.localAssetId {
      loadLocalAsset(localAssetId, itemId: item.id, imageManager: imageManager)
    } else if let uri = item.thumbnailUri ?? Self.persistentThumbnailURL(for: item.id)?.path {
      loadFileThumbnail(uri, itemId: item.id)
    }
  }

  static func prefetch(items: [NativePhotoGridItem], columns: Int, containerWidth: CGFloat, imageManager: PHImageManager) {
    let targetPixels = targetPixels(forSide: containerWidth / CGFloat(max(columns, 1)))
    for item in items {
      let sourceKey = sourceKey(for: item)
      if sourceImageCache.object(forKey: sourceKey as NSString) != nil {
        continue
      }
      if let localAssetId = item.localAssetId {
        enqueueLocalAsset(
          localAssetId,
          sourceKey: sourceKey,
          targetPixels: targetPixels,
          imageManager: imageManager,
          priority: .prefetch,
          completion: nil
        )
      }
    }
  }

  static func cancelPrefetch(items: [NativePhotoGridItem]) {
    // Keep in-flight thumbnail work alive so fast reverse scrolling reuses the warmed cache.
  }

  func setSelectionMode(_ enabled: Bool, selected: Bool) {
    selectionOverlay.isHidden = !enabled || !selected
    selectionBadge.isHidden = !enabled
    selectionCheck.isHidden = !selected
    selectionBadge.layer.borderColor = (selected ? UIColor(red: 0.965, green: 0.753, blue: 0.227, alpha: 1) : UIColor.white.withAlphaComponent(0.8)).cgColor
    selectionBadge.backgroundColor = selected ? UIColor(red: 0.965, green: 0.753, blue: 0.227, alpha: 1) : UIColor.black.withAlphaComponent(0.35)
  }

  private func loadFileThumbnail(_ uri: String, itemId: String) {
    let url = Self.fileURL(from: uri)
    let targetPixels = max(96, Int(ceil(max(bounds.width, bounds.height) * UIScreen.main.scale)))
    let cacheKey = "\(url.path)#\(targetPixels)" as NSString
    if let cached = Self.fileImageCache.object(forKey: cacheKey) {
      Self.metrics.fileCacheHits += 1
      imageView.image = cached
      if let representedSourceKey {
        Self.sourceImageCache.setObject(cached, forKey: representedSourceKey as NSString)
      }
      return
    }
    fileLoadInFlightKey = representedSourceKey
    let sourceKey = representedSourceKey
    Self.metrics.fileLoadStarts += 1
    Self.fileLoadQueue.addOperation { [weak self] in
      let image = Self.downsampledImage(from: url, maxPixelSize: targetPixels)
      if let image {
        Self.fileImageCache.setObject(image, forKey: cacheKey)
        if let sourceKey {
          Self.sourceImageCache.setObject(image, forKey: sourceKey as NSString)
        }
      }
      DispatchQueue.main.async {
        guard self?.representedId == itemId else { return }
        self?.fileLoadInFlightKey = nil
        if let image {
          self?.imageView.image = image
        }
      }
    }
  }

  private func loadLocalAsset(_ localIdentifier: String, itemId: String, imageManager: PHImageManager) {
    guard let sourceKey = representedSourceKey else { return }
    localLoadInFlightKey = sourceKey
    let targetPixels = Self.targetPixels(forSide: max(bounds.width, bounds.height))
    Self.enqueueLocalAsset(
      localIdentifier,
      sourceKey: sourceKey,
      targetPixels: targetPixels,
      imageManager: imageManager,
      priority: .visible
    ) { [weak self] image in
      guard self?.representedId == itemId else { return }
      self?.localLoadInFlightKey = nil
      if let image {
        self?.imageView.image = image
      }
    }
  }

  static func metricsSnapshot() -> Metrics {
    metrics
  }

  private enum LocalLoadPriority {
    case visible
    case prefetch
  }

  private static func enqueueLocalAsset(
    _ localIdentifier: String,
    sourceKey: String,
    targetPixels: Int,
    imageManager: PHImageManager,
    priority: LocalLoadPriority,
    completion: ((UIImage?) -> Void)?
  ) {
    if let cached = sourceImageCache.object(forKey: sourceKey as NSString) {
      if let completion {
        DispatchQueue.main.async {
          completion(cached)
        }
      }
      return
    }

    localLoadLock.lock()
    if let existing = localLoadOperations[sourceKey] {
      if priority == .visible {
        existing.queuePriority = .veryHigh
        existing.qualityOfService = .userInitiated
      }
      if let completion {
        localLoadCompletions[sourceKey, default: []].append(completion)
      }
      localLoadLock.unlock()
      return
    }
    if let completion {
      localLoadCompletions[sourceKey, default: []].append(completion)
    }
    let operation = BlockOperation {
      let assets = PHAsset.fetchAssets(withLocalIdentifiers: [localIdentifier], options: nil)
      guard let asset = assets.firstObject else {
        Self.finishLocalLoad(sourceKey: sourceKey, image: nil)
        return
      }
      Self.metrics.localAssetStarts += 1
      let size = CGSize(width: targetPixels, height: targetPixels)
      let options = PHImageRequestOptions()
      options.deliveryMode = .fastFormat
      options.resizeMode = .fast
      options.isNetworkAccessAllowed = false
      options.isSynchronous = true
      var loadedImage: UIImage?
      imageManager.requestImage(
        for: asset,
        targetSize: size,
        contentMode: .aspectFill,
        options: options
      ) { image, _ in
        loadedImage = image
      }
      Self.finishLocalLoad(sourceKey: sourceKey, image: loadedImage)
    }
    if priority == .visible {
      operation.queuePriority = .veryHigh
      operation.qualityOfService = .userInitiated
    } else {
      operation.queuePriority = .low
      operation.qualityOfService = .utility
    }
    localLoadOperations[sourceKey] = operation
    localLoadLock.unlock()
    localLoadQueue.addOperation(operation)
  }

  private static func finishLocalLoad(sourceKey: String, image: UIImage?) {
    if let image {
      sourceImageCache.setObject(image, forKey: sourceKey as NSString)
    }
    localLoadLock.lock()
    localLoadOperations[sourceKey] = nil
    let completions = localLoadCompletions.removeValue(forKey: sourceKey) ?? []
    localLoadLock.unlock()
    guard !completions.isEmpty else { return }
    DispatchQueue.main.async {
      completions.forEach { $0(image) }
    }
  }

  private static func targetPixels(forSide side: CGFloat) -> Int {
    let scale = UIScreen.main.scale
    if side < 56 {
      return 128
    }
    if side < 96 {
      return 200
    }
    if side < 140 {
      return max(320, Int(ceil(side * scale)))
    }
    if side < 220 {
      return max(640, Int(ceil(side * scale)))
    }
    return min(1024, max(768, Int(ceil(side * scale))))
  }

  private static func sourceKey(for item: NativePhotoGridItem) -> String {
    if let localAssetId = item.localAssetId {
      return "local:\(localAssetId)"
    }
    if let thumbnailUri = item.thumbnailUri {
      return "file:\(thumbnailUri)"
    }
    if let persistentThumbnail = persistentThumbnailURL(for: item.id) {
      return "file:\(persistentThumbnail.path)"
    }
    return "placeholder:\(item.id)"
  }

  private static func fileURL(from uri: String) -> URL {
    if let parsed = URL(string: uri), parsed.isFileURL {
      return parsed
    }
    return URL(fileURLWithPath: uri)
  }

  private static func downsampledImage(from url: URL, maxPixelSize: Int) -> UIImage? {
    let options = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithURL(url as CFURL, options) else {
      return (try? Data(contentsOf: url)).flatMap { UIImage(data: $0) }
    }
    let thumbnailOptions = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixelSize,
    ] as CFDictionary
    guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions) else {
      return (try? Data(contentsOf: url)).flatMap { UIImage(data: $0) }
    }
    return UIImage(cgImage: cgImage)
  }

  private static func persistentThumbnailURL(for fileId: String) -> URL? {
    guard let documentDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
      return nil
    }
    for directoryName in ["beebeeb-thumbnails-v3"] {
      let directory = documentDirectory.appendingPathComponent(directoryName, isDirectory: true)
      let webp = directory.appendingPathComponent("\(fileId).webp")
      if FileManager.default.fileExists(atPath: webp.path) {
        return webp
      }
      let legacyJpg = directory.appendingPathComponent("\(fileId).jpg")
      if FileManager.default.fileExists(atPath: legacyJpg.path) {
        return legacyJpg
      }
    }
    return nil
  }
}

private final class PhotoGridHeaderView: UICollectionReusableView {
  static let reuseIdentifier = "PhotoGridHeaderView"

  private let label = UILabel()
  private let count = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.font = UIFont.systemFont(ofSize: 13, weight: .semibold)
    count.font = UIFont.systemFont(ofSize: 10, weight: .regular)
    label.textColor = UIColor.white.withAlphaComponent(0.88)
    count.textColor = UIColor.white.withAlphaComponent(0.45)
    addSubview(label)
    addSubview(count)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    label.sizeToFit()
    count.sizeToFit()
    label.frame.origin = CGPoint(x: 18, y: bounds.height - label.bounds.height - 6)
    count.frame.origin = CGPoint(x: label.frame.maxX + 8, y: bounds.height - count.bounds.height - 7)
  }

  func configure(label: String, count: Int) {
    self.label.text = label
    self.count.text = "\(count) \(count == 1 ? "item" : "items")"
    setNeedsLayout()
  }
}

private extension UIColor {
  convenience init?(hexString: String?) {
    guard var raw = hexString?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      return nil
    }
    if raw.hasPrefix("#") {
      raw.removeFirst()
    }
    guard raw.count == 6, let value = Int(raw, radix: 16) else {
      return nil
    }
    self.init(
      red: CGFloat((value >> 16) & 0xff) / 255,
      green: CGFloat((value >> 8) & 0xff) / 255,
      blue: CGFloat(value & 0xff) / 255,
      alpha: 1
    )
  }
}

private extension PHFetchResult where ObjectType == PHAsset {
  func objects() -> [PHAsset] {
    var assets: [PHAsset] = []
    enumerateObjects { asset, _, _ in
      assets.append(asset)
    }
    return assets
  }
}
