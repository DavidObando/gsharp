package fixture

var LastInitialized = FirstInitialized + 1

func init() {
	MapValue["last"] = LastInitialized
}
