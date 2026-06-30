package Oahu.Decrypt

import System

class ConversionProgressEventArgs : EventArgs {
    internal init(startTime TimeSpan, endTime TimeSpan, processPosition TimeSpan, processSpeed float64) {
        StartTime = startTime
        EndTime = endTime
        ProcessPosition = processPosition
        ProcessSpeed = processSpeed
        FractionCompleted = (processPosition - startTime) / (endTime - startTime)
    }

    prop ProcessPosition TimeSpan {
        get;
        init;
    }

    prop StartTime TimeSpan {
        get;
        init;
    }

    prop EndTime TimeSpan {
        get;
        init;
    }

    prop ProcessSpeed float64 {
        get;
        init;
    }

    prop FractionCompleted float64 {
        get;
        init;
    }
}
