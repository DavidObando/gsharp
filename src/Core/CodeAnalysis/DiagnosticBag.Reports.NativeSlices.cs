// <copyright file="DiagnosticBag.Reports.NativeSlices.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Text;

namespace GSharp.Core.CodeAnalysis;

public sealed partial class DiagnosticBag
{
    internal void ReportNativeSliceRuntime(TextLocation location)
        => Report(location, DiagnosticDescriptors.NativeSliceRuntime);

    internal void ReportNativeSliceType(TextLocation location, string reason)
        => Report(location, DiagnosticDescriptors.NativeSliceType, reason);

    internal void ReportNativeSliceSuspendingWrite(TextLocation location)
        => Report(location, DiagnosticDescriptors.NativeSliceSuspendingWrite);

    internal void ReportNativeSliceReadOnlyElement(TextLocation location)
        => Report(location, DiagnosticDescriptors.NativeSliceReadOnlyElement);
}
