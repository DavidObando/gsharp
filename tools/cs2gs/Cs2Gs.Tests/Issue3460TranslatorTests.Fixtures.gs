// <copyright file="Issue3460TranslatorTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests.Fixtures

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import Microsoft.CodeAnalysis
import System
import System.Collections.Generic
import System.Linq
import Xunit

class Issue3460ImportedOptions {
    init() {
        Values = List[int32]()
        Trace = (Trace * 10) + 1
    }

    init(marker int32) {
        Values = List[int32]()
        Trace = (Trace * 10) + marker
    }

    prop Required string {
        get;
        init;
    }

    prop InitOnly int32 {
        get;
        init;
    }

    prop Value int32
    private var _nested Issue3460NestedOptions = Issue3460NestedOptions()

    prop Nested Issue3460NestedOptions {
        get {
            return _nested
        }
        set {
            _nested = value
        }
    }

    prop Values List[int32] {
        get;
    }

    shared {
        prop Trace int32
    }
}

class Issue3460NestedOptions {
    prop Value int32
}

class Issue3460OptionalOptions {
    init(marker int32 = 7) {
        Marker = marker
    }

    prop Marker int32 {
        get;
    }

    prop Value int32 {
        get;
        init;
    }
}

class Issue3460OverloadedOptionalOptions {
    init(marker int16 = 7) {
        Selected = 1
    }

    init(marker int32) {
        Selected = 2
    }

    prop Selected int32 {
        get;
    }

    prop Value int32 {
        get;
        init;
    }
}

class Issue3460ParamsCollectionOptions {
    init(values ...List[int32]) {
        Count = values.Count
    }

    prop Count int32 {
        get;
    }

    prop Value int32 {
        get;
        init;
    }
}

class Issue3460OptionalParamsCollectionOptions {
    init(marker int32 = 7, values ...List[int32]) {
        Marker = marker
        Count = values.Count
    }

    prop Marker int32 {
        get;
    }

    prop Count int32 {
        get;
    }

    prop Value int32 {
        get;
        init;
    }
}

class Issue3460ParamsInterfaceOverloadOptions {
    init(values ...IEnumerable[int32]) {
        Selected = 1
        Count = values.Count()
    }

    init(values List[int32]) {
        Selected = 2
        Count = values.Count
    }

    prop Selected int32 {
        get;
    }

    prop Count int32 {
        get;
    }

    prop Value int32 {
        get;
        init;
    }
}

class Issue3460SpanParamsOptions {
    init(values ...ReadOnlySpan[int32]) {
        Count = values.Length
    }

    prop Count int32 {
        get;
    }

    prop Value int32 {
        get;
        init;
    }
}

// NOTE: the deliberately UNTRANSLATABLE `params HashSet<int>` fixture is
// compiled in-memory by its test (see CompileUnsupportedParamsLibrary) so
// this project's own source stays fully cs2gs-translatable for #3501.
class Issue3460StringDefaultOptions {
    init(marker string = "selected") {
        Selected = 1
        Marker = marker
    }

    init(marker object) {
        Selected = 2
        Marker = marker.ToString()
    }

    prop Selected int32 {
        get;
    }

    prop Marker string? {
        get;
    }

    prop Value int32 {
        get;
        init;
    }
}

class Issue3460NonNullNestedHolder {
    init() {
        Nested = Issue3460NestedOptions()
    }

    prop Nested Issue3460NestedOptions {
        get;
    }
}

class Issue3460NullNestedHolder {
    prop Nested Issue3460NestedOptions {
        get;
    }
}

class Issue3460NullCollectionHolder {
    prop Values List[int32] {
        get;
    }
}
