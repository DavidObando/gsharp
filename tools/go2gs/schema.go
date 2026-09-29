// Copyright (C) GSharp Authors. All rights reserved.

package main

import "encoding/json"

type Profile struct {
	Schema                SchemaHandshake   `json:"schema"`
	ID                    string            `json:"id"`
	EntryPatterns         []string          `json:"entryPatterns"`
	RequestedGoVersion    string            `json:"requestedGoVersion"`
	ExpectedSourceCommit  string            `json:"expectedSourceCommit,omitempty"`
	LoadTests             bool              `json:"loadTests"`
	GOOS                  string            `json:"goos"`
	GOARCH                string            `json:"goarch"`
	ArchitectureFeatures  []string          `json:"architectureFeatures,omitempty"`
	BuildTags             []string          `json:"buildTags,omitempty"`
	CGOEnabled            bool              `json:"cgoEnabled"`
	GOFLAGS               []string          `json:"goFlags,omitempty"`
	GOEXPERIMENT          string            `json:"goExperiment,omitempty"`
	GODEBUG               map[string]string `json:"goDebug,omitempty"`
	ModuleMode            string            `json:"moduleMode"`
	VendorMode            bool              `json:"vendorMode"`
	WorkspaceMode         string            `json:"workspaceMode"`
	Offline               bool              `json:"offline"`
	AllowNetwork          bool              `json:"allowNetwork"`
	AllowGOPACKAGESDRIVER bool              `json:"allowGoPackagesDriver"`
	Limits                Limits            `json:"limits"`
}

type Limits struct {
	MaxDurationSeconds int   `json:"maxDurationSeconds"`
	MaxPackages        int   `json:"maxPackages"`
	MaxFiles           int   `json:"maxFiles"`
	MaxRecords         int   `json:"maxRecords"`
	MaxStringBytes     int   `json:"maxStringBytes"`
	MaxLogBytes        int   `json:"maxLogBytes"`
	MaxOutputBytes     int64 `json:"maxOutputBytes"`
	MaxLocalHashBytes  int64 `json:"maxLocalHashBytes"`
}

type SchemaHandshake struct {
	Name                string   `json:"name"`
	Version             int      `json:"version"`
	RequiredRecordKinds []string `json:"requiredRecordKinds"`
}

type Analysis struct {
	Schema             SchemaHandshake     `json:"schema"`
	Tool               VersionIdentity     `json:"tool"`
	Helper             VersionIdentity     `json:"helper"`
	Profile            ProfileSnapshot     `json:"profile"`
	Toolchain          ToolchainProvenance `json:"toolchain"`
	Manifests          []ManifestRecord    `json:"manifests"`
	Modules            []ModuleRecord      `json:"modules"`
	Packages           []PackageRecord     `json:"packages"`
	Files              []FileRecord        `json:"files"`
	Types              []TypeRecord        `json:"types"`
	Symbols            []SymbolRecord      `json:"symbols"`
	Nodes              []NodeRecord        `json:"nodes"`
	Constants          []ConstantRecord    `json:"constants"`
	Scopes             []ScopeRecord       `json:"scopes"`
	Selections         []SelectionRecord   `json:"selections"`
	Calls              []CallRecord        `json:"calls"`
	MethodSets         []MethodSetRecord   `json:"methodSets"`
	Instances          []InstanceRecord    `json:"instances"`
	Embeds             []EmbedRecord       `json:"embeds"`
	GenerateDirectives []GenerateRecord    `json:"generateDirectives"`
	Dependencies       []DependencyRecord  `json:"dependencies"`
	FeatureSites       []FeatureSite       `json:"featureSites"`
	Diagnostics        []DiagnosticRecord  `json:"diagnostics"`
	Blockers           []BlockerRecord     `json:"blockers"`
	RecordCounts       RecordCounts        `json:"recordCounts"`
	InventoryComplete  bool                `json:"inventoryComplete"`
	MigrationReady     bool                `json:"migrationReady"`
}

type VersionIdentity struct {
	Version string `json:"version"`
	SHA256  string `json:"sha256"`
}

type ProfileSnapshot struct {
	ID                     string            `json:"id"`
	SHA256                 string            `json:"sha256"`
	SourceRootIdentity     string            `json:"sourceRootIdentity"`
	ExpectedSourceCommit   string            `json:"expectedSourceCommit,omitempty"`
	ActualSourceCommit     string            `json:"actualSourceCommit,omitempty"`
	EntryPatterns          []string          `json:"entryPatterns"`
	LoadTests              bool              `json:"loadTests"`
	GOOS                   string            `json:"goos"`
	GOARCH                 string            `json:"goarch"`
	ArchitectureFeatures   []string          `json:"architectureFeatures"`
	BuildTags              []string          `json:"buildTags"`
	CGOEnabled             bool              `json:"cgoEnabled"`
	GOFLAGS                []string          `json:"goFlags"`
	GOEXPERIMENT           string            `json:"goExperiment,omitempty"`
	GODEBUG                map[string]string `json:"goDebug"`
	ModuleMode             string            `json:"moduleMode"`
	VendorMode             bool              `json:"vendorMode"`
	WorkspaceMode          string            `json:"workspaceMode"`
	Offline                bool              `json:"offline"`
	AllowNetwork           bool              `json:"allowNetwork"`
	GeneratorsExecuted     bool              `json:"generatorsExecuted"`
	TargetBinariesExecuted bool              `json:"targetBinariesExecuted"`
	TrustBoundary          string            `json:"trustBoundary"`
	Limits                 Limits            `json:"limits"`
}

type ToolchainProvenance struct {
	RequestedVersion    string `json:"requestedVersion"`
	ActualVersion       string `json:"actualVersion"`
	ExecutableSHA256    string `json:"executableSha256"`
	ExecutableName      string `json:"executableName"`
	GOROOTIdentity      string `json:"gorootIdentity"`
	GOROOTVersionSHA256 string `json:"gorootVersionSha256"`
	GOROOTSource        string `json:"gorootSource"`
	AutoDownload        bool   `json:"autoDownload"`
}

type ManifestRecord struct {
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type ModuleRecord struct {
	ID                 string `json:"id"`
	Path               string `json:"path"`
	Version            string `json:"version,omitempty"`
	GoVersion          string `json:"goVersion,omitempty"`
	Main               bool   `json:"main"`
	ReplacementID      string `json:"replacementId,omitempty"`
	LocalContentSHA256 string `json:"localContentSha256,omitempty"`
	VendorProvenance   string `json:"vendorProvenance,omitempty"`
}

type PackageRecord struct {
	ID                  string                 `json:"id"`
	ImportPath          string                 `json:"importPath"`
	Name                string                 `json:"name"`
	Variant             string                 `json:"variant"`
	ModuleID            string                 `json:"moduleId,omitempty"`
	LanguageVersion     string                 `json:"languageVersion,omitempty"`
	FileIDs             []string               `json:"fileIds"`
	CompiledFileIDs     []string               `json:"compiledFileIds"`
	ImportPackageIDs    []string               `json:"importPackageIds"`
	InitializationOrder []InitializationRecord `json:"initializationOrder"`
	DiagnosticIDs       []string               `json:"diagnosticIds"`
	InventoryComplete   bool                   `json:"inventoryComplete"`
}

type InitializationRecord struct {
	Order     int      `json:"order"`
	Kind      string   `json:"kind"`
	FileID    string   `json:"fileId,omitempty"`
	NodeID    string   `json:"nodeId,omitempty"`
	SymbolIDs []string `json:"symbolIds"`
}

type FileRecord struct {
	ID              string `json:"id"`
	PackageID       string `json:"packageId"`
	Path            string `json:"path"`
	Role            string `json:"role"`
	Reason          string `json:"reason,omitempty"`
	LanguageVersion string `json:"languageVersion,omitempty"`
	SHA256          string `json:"sha256"`
	Bytes           int64  `json:"bytes"`
	ContentBase64   string `json:"contentBase64"`
	ValidUTF8       bool   `json:"validUtf8"`
	Generated       bool   `json:"generated"`
	Native          bool   `json:"native"`
	Embed           bool   `json:"embed"`
	Provenance      string `json:"provenance"`
}

type TypeRecord struct {
	ID         string              `json:"id"`
	Kind       string              `json:"kind"`
	Canonical  string              `json:"canonical"`
	Display    string              `json:"display"`
	Package    string              `json:"package,omitempty"`
	Name       string              `json:"name,omitempty"`
	Alias      bool                `json:"alias"`
	Named      bool                `json:"named"`
	TypeArgs   []string            `json:"typeArgs"`
	Underlying string              `json:"underlying,omitempty"`
	Constraint string              `json:"constraint,omitempty"`
	Fields     []StructFieldRecord `json:"fields"`
	Comparable bool                `json:"comparable"`
	Size       int64               `json:"size"`
	Align      int64               `json:"align"`
}

type StructFieldRecord struct {
	Name      string `json:"name"`
	TypeID    string `json:"typeId"`
	TagBase64 string `json:"tagBase64,omitempty"`
	Exported  bool   `json:"exported"`
	Embedded  bool   `json:"embedded"`
}

type SymbolRecord struct {
	ID          string      `json:"id"`
	PackageID   string      `json:"packageId"`
	Name        string      `json:"name"`
	Kind        string      `json:"kind"`
	TypeID      string      `json:"typeId,omitempty"`
	Exported    bool        `json:"exported"`
	Declaration *SourceSpan `json:"declaration,omitempty"`
}

type NodeRecord struct {
	ID               string     `json:"id"`
	ParentID         string     `json:"parentId,omitempty"`
	PackageID        string     `json:"packageId"`
	FileID           string     `json:"fileId"`
	Kind             string     `json:"kind"`
	Span             SourceSpan `json:"span"`
	OriginalTypeID   string     `json:"originalTypeId,omitempty"`
	EffectiveTypeID  string     `json:"effectiveTypeId,omitempty"`
	DeclarationID    string     `json:"declarationId,omitempty"`
	UseID            string     `json:"useId,omitempty"`
	ScopeID          string     `json:"scopeId,omitempty"`
	Addressable      bool       `json:"addressable"`
	Assignable       bool       `json:"assignable"`
	IsType           bool       `json:"isType"`
	IsValue          bool       `json:"isValue"`
	IsNil            bool       `json:"isNil"`
	IsBuiltin        bool       `json:"isBuiltin"`
	ConversionTypeID string     `json:"conversionTypeId,omitempty"`
}

type SourceSpan struct {
	Path          string `json:"path"`
	StartByte     int    `json:"startByte"`
	EndByte       int    `json:"endByte"`
	StartLine     int    `json:"startLine"`
	StartColumn   int    `json:"startColumn"`
	EndLine       int    `json:"endLine"`
	EndColumn     int    `json:"endColumn"`
	DisplayPath   string `json:"displayPath"`
	DisplayLine   int    `json:"displayLine"`
	DisplayColumn int    `json:"displayColumn"`
	LineDirective bool   `json:"lineDirective"`
}

type ConstantRecord struct {
	ID             string     `json:"id"`
	NodeID         string     `json:"nodeId"`
	SymbolID       string     `json:"symbolId,omitempty"`
	TypeID         string     `json:"typeId,omitempty"`
	Category       string     `json:"category"`
	Exact          string     `json:"exact"`
	RealExact      string     `json:"realExact,omitempty"`
	ImaginaryExact string     `json:"imaginaryExact,omitempty"`
	Untyped        bool       `json:"untyped"`
	ContextTypeID  string     `json:"contextTypeId,omitempty"`
	Iota           bool       `json:"iota"`
	ArrayLength    bool       `json:"arrayLength"`
	Span           SourceSpan `json:"span"`
}

type ScopeRecord struct {
	ID        string     `json:"id"`
	PackageID string     `json:"packageId"`
	ParentID  string     `json:"parentId,omitempty"`
	Span      SourceSpan `json:"span"`
	SymbolIDs []string   `json:"symbolIds"`
	Labels    []string   `json:"labels"`
}

type SelectionRecord struct {
	ID             string `json:"id"`
	NodeID         string `json:"nodeId"`
	Kind           string `json:"kind"`
	ObjectID       string `json:"objectId"`
	ReceiverTypeID string `json:"receiverTypeId"`
	TypeID         string `json:"typeId"`
	IndexPath      []int  `json:"indexPath"`
	Indirect       bool   `json:"indirect"`
}

type CallRecord struct {
	ID              string   `json:"id"`
	NodeID          string   `json:"nodeId"`
	Kind            string   `json:"kind"`
	CalleeSymbolID  string   `json:"calleeSymbolId,omitempty"`
	SignatureTypeID string   `json:"signatureTypeId,omitempty"`
	ArgumentTypeIDs []string `json:"argumentTypeIds"`
	Variadic        bool     `json:"variadic"`
	Ellipsis        bool     `json:"ellipsis"`
	Builtin         string   `json:"builtin,omitempty"`
}

type MethodSetRecord struct {
	ID              string   `json:"id"`
	TypeID          string   `json:"typeId"`
	Pointer         bool     `json:"pointer"`
	MethodSymbolIDs []string `json:"methodSymbolIds"`
}

type InstanceRecord struct {
	ID         string   `json:"id"`
	NodeID     string   `json:"nodeId"`
	TypeID     string   `json:"typeId"`
	TypeArgIDs []string `json:"typeArgIds"`
}

type EmbedRecord struct {
	ID            string `json:"id"`
	PackageID     string `json:"packageId"`
	FileID        string `json:"fileId"`
	Pattern       string `json:"pattern"`
	LogicalName   string `json:"logicalName"`
	ContentSHA256 string `json:"contentSha256"`
}

type GenerateRecord struct {
	ID        string     `json:"id"`
	FileID    string     `json:"fileId"`
	Directive string     `json:"directive"`
	Executed  bool       `json:"executed"`
	Span      SourceSpan `json:"span"`
}

type DependencyRecord struct {
	ID            string `json:"id"`
	FromPackageID string `json:"fromPackageId"`
	ImportPath    string `json:"importPath"`
	PackageID     string `json:"packageId,omitempty"`
	Disposition   string `json:"disposition"`
	Reason        string `json:"reason,omitempty"`
}

type FeatureSite struct {
	ID          string     `json:"id"`
	NodeID      string     `json:"nodeId"`
	PackageID   string     `json:"packageId"`
	FileID      string     `json:"fileId"`
	Feature     string     `json:"feature"`
	Disposition string     `json:"disposition"`
	Span        SourceSpan `json:"span"`
}

type DiagnosticRecord struct {
	ID        string      `json:"id"`
	Category  string      `json:"category"`
	Severity  string      `json:"severity"`
	Message   string      `json:"message"`
	Position  string      `json:"position,omitempty"`
	PackageID string      `json:"packageId,omitempty"`
	Span      *SourceSpan `json:"span,omitempty"`
	Truncated bool        `json:"truncated"`
}

type BlockerRecord struct {
	ID            string   `json:"id"`
	Blocks        string   `json:"blocks"`
	Category      string   `json:"category"`
	Message       string   `json:"message"`
	AffectedUnits []string `json:"affectedUnits"`
	DiagnosticIDs []string `json:"diagnosticIds"`
}

type RecordCounts struct {
	Modules            int `json:"modules"`
	Packages           int `json:"packages"`
	Files              int `json:"files"`
	Types              int `json:"types"`
	Symbols            int `json:"symbols"`
	Nodes              int `json:"nodes"`
	Constants          int `json:"constants"`
	Scopes             int `json:"scopes"`
	Selections         int `json:"selections"`
	Calls              int `json:"calls"`
	MethodSets         int `json:"methodSets"`
	Instances          int `json:"instances"`
	Embeds             int `json:"embeds"`
	GenerateDirectives int `json:"generateDirectives"`
	Dependencies       int `json:"dependencies"`
	FeatureSites       int `json:"featureSites"`
	Diagnostics        int `json:"diagnostics"`
	Blockers           int `json:"blockers"`
	Total              int `json:"total"`
}

type RunMetadata struct {
	SchemaVersion       int    `json:"schemaVersion"`
	ColdLoadNanoseconds int64  `json:"coldLoadNanoseconds"`
	WarmLoadMeasured    bool   `json:"warmLoadMeasured"`
	WarmLoadReason      string `json:"warmLoadReason"`
	PeakRSSBytes        int64  `json:"peakRssBytes"`
	AnalysisBytes       int64  `json:"analysisBytes"`
	PackageCount        int    `json:"packageCount"`
	RecordCount         int    `json:"recordCount"`
}

type rawRecord struct {
	Kind string          `json:"kind"`
	ID   string          `json:"id"`
	Data json.RawMessage `json:"data"`
}
