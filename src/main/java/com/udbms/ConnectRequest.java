package com.udbms;

public record ConnectRequest(String type, String host, Integer port, String database,
                             String username, String password, String uri) {}
