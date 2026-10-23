// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Text

partial class DiagnosticBag {
    internal func ReportNativeProtocol(location TextLocation, reason string) ->
    Report(location, DiagnosticDescriptors.NativeProtocol, reason)
}
