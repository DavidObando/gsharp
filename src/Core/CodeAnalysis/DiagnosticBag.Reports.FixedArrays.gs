// Copyright (C) GSharp Authors. All rights reserved.

package GSharp.Core.CodeAnalysis

import GSharp.Core.CodeAnalysis.Text

partial class DiagnosticBag {
    internal func ReportFixedArrayContract(location TextLocation, reason string) ->
    Report(location, DiagnosticDescriptors.FixedArrayContract, reason)
}
