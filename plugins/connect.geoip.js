var geoip     = require('geoip-lite'),
    net       = require('net'),
    net_utils = require('./net_utils');

var local_ip, local_geoip;

exports.hook_connect = function (next, connection) {
    var plugin = this;

    // geoip.lookup results look like this:
    // range: [ 3479299040, 3479299071 ],
    //    country: 'US',
    //    region: 'CA',
    //    city: 'San Francisco',
    //    ll: [37.7484, -122.4156]

    var r = geoip.lookup(connection.remote_ip);
    if (!r) return next();

    connection.results.add(plugin, r);

    var cfg = plugin.config.get('connect.geoip.ini');
    if (cfg.main.calc_distance) {
        r.distance = plugin.calculate_distance(connection, r);
    }

    var show = [ r.country ];
    if (r.region   && cfg.main.show_region) show.push(r.region);
    if (r.city     && cfg.main.show_city  ) show.push(r.city);
    if (r.distance                        ) show.push(r.distance+'km');

    connection.results.add(plugin, {human: show.join(', '), emit:true});

    return next();
};

exports.hook_data_post = function (next, connection) {
    var plugin = this;
    var txn = connection.transaction;
    if (!txn) return;
    txn.remove_header('X-Haraka-GeoIP');
    txn.remove_header('X-Haraka-GeoIP-Received');
    var geoip = connection.results.get('connect.geoip');
    if (geoip) {
        txn.add_header('X-Haraka-GeoIP', geoip.human);
    }

    var received = [];

    var rh = plugin.received_headers(connection);
    if (rh) received.push(rh);
    if (!rh) plugin.user_agent(connection); // No received headers.

    var oh = plugin.originating_headers(connection);
    if (oh) received.push(oh);

    // Add any received results to a trace header
    if (received.length) {
        txn.add_header('X-Haraka-GeoIP-Received', received.join(' '));
    }
    return next();
};

exports.calculate_distance = function (connection, r_geoip) {
    var plugin = this;
    var cfg = plugin.config.get('connect.geoip.ini');

    if (!local_ip) { local_ip = cfg.main.public_ip; }
    if (!local_ip) { local_ip = connection.local_ip; }
    if (!local_ip) {
        connection.logerror(plugin, "can't calculate distance without local IP!");
        return;
    }

    if (!local_geoip) { local_geoip = geoip.lookup(local_ip); }
    if (!local_geoip) {
        connection.logerror(plugin, "no GeoIP results for local_ip!");
        return;
    }

    var gcd = haversine(local_geoip.ll[0], local_geoip.ll[1], r_geoip.ll[0], r_geoip.ll[1]);

    connection.results.add(plugin, {distance: gcd});

    if (cfg.main.too_far && (parseFloat(cfg.main.too_far) < parseFloat(gcd))) {
        connection.results.add(plugin, {too_far: true});
    }
    return gcd;
};

function haversine(lat1, lon1, lat2, lon2) {
    // calculate the great circle distance using the haversine formula
    // found here: http://www.movable-type.co.uk/scripts/latlong.html
    var R = 6371; // km
    function toRad(v) { return v * Math.PI / 180; };
    var dLat = toRad(lat2-lat1);
    var dLon = toRad(lon2-lon1);
    var lat1 = toRad(lat1);
    var lat2 = toRad(lat2);

    var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.sin(dLon/2) * Math.sin(dLon/2) * Math.cos(lat1) * Math.cos(lat2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    var d = R * c;
    return d.toFixed(0);
}

exports.received_headers = function (connection) {
    var plugin = this;
    var txn = connection.transaction;
    var received = txn.header.get_all('received');
    if (!received.length) return;

    var results = [];

    // Try and parse each received header
    for (var i=0; i < received.length; i++) {
        var match = /\[(\d+\.\d+\.\d+\.\d+)\]/.exec(received[i]);
        if (!match) continue;
        if (!net.isIPv4(match[1])) continue;  // TODO: support IPv6
        if (net_utils.is_rfc1918(match[1])) continue;  // exclude private IP

        var gi = geoip.lookup(match[1]);
        connection.loginfo(plugin, 'received=' + match[1] + ' country=' + ((gi) ? gi.country : 'UNKNOWN'));
        results.push(match[1] + ':' + ((gi) ? gi.country : 'UNKNOWN'));
    }
    return results;
};

exports.originating_headers = function (connection) {
    var plugin = this;
    var txn = connection.transaction;

    // Try and parse any originating IP headers
    var orig = txn.header.get('x-originating-ip') ||
               txn.header.get('x-ip') ||
               txn.header.get('x-remote-ip');

    if (!orig) return;

    var match = /(\d+\.\d+\.\d+\.\d+)/.exec(orig);
    if (!match) return;
    var found_ip = match[1];
    if (!net.isIPv4(found_ip)) return;
    if (net_utils.is_rfc1918(found_ip)) return;

    var gi = geoip.lookup(found_ip);
    connection.loginfo(plugin, 'originating=' + found_ip + ' country=' + ((gi) ? gi.country : 'UNKNOWN'));
    return found_ip + ':' + ((gi) ? gi.country : 'UNKNOWN');
};